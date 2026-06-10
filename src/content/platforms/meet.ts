import { sendToBackground } from "../../shared/messages"
import { getSettings, sessionKey, setLocal, withDefaults } from "../../shared/storage"
import type { ActiveSession, Settings } from "../../shared/types"
import { ChatLog, TranscriptCollector } from "../core/collector"
import { SessionWriter } from "../core/persistence"
import { mountPrivacyPill, pulseActivity, showToast } from "../core/ui"

// --- Google Meet DOM contract. Verify on a live meeting before each release. ---
const ICON_FONT = ".google-symbols"
const LEAVE_ICON_TEXT = "call_end"
const CAPTIONS_OFF_ICON_TEXT = "closed_caption_off"
const CHAT_ICON_TEXT = "chat"
const CAPTIONS_REGION = 'div[role="region"][tabindex="0"]'
const CHAT_LIST = 'div[aria-live="polite"].Ge9Kpc'
const SELF_NAME = ".awLEm"
const MEETING_TITLE = ".u6vdEc"
// -------------------------------------------------------------------------------

const HIDE_CAPTIONS_STYLE_ID = "platica-hide-captions"
// Meet restarts very long captions of one speaker; a sharp text shrink signals it.
const MONOLOGUE_RESET_DROP = 250
const MEETING_PATH = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i

void main().catch((error) => console.error("[platica-notes]", error))

async function main(): Promise<void> {
  // Only meeting pages look like /abc-defg-hij
  if (!MEETING_PATH.test(location.pathname)) return

  const tabIdResponse = await sendToBackground<number>({ kind: "getTabId" })
  if (!tabIdResponse.ok) {
    console.error("[platica-notes] could not get tab id:", tabIdResponse.error)
    return
  }
  const tabId = tabIdResponse.data
  const settings = await getSettings()

  let selfName = "You"
  void captureSelfName().then((name) => { if (name) selfName = name })

  await waitForIcon(LEAVE_ICON_TEXT)
  await sendToBackground({ kind: "meetingStarted" })

  const session: ActiveSession = {
    platform: "meet",
    title: document.title,
    startedAt: new Date().toISOString(),
    localOnly: !settings.uploadToDriveByDefault,
    transcript: [],
    chat: [],
  }
  const collector = new TranscriptCollector()
  const chatLog = new ChatLog()
  const writer = new SessionWriter<ActiveSession>(
    (snapshot) => setLocal({ [sessionKey(tabId)]: snapshot }),
    () => session,
  )
  writer.requestWrite()

  mountPrivacyPill(session.localOnly, (localOnly) => {
    session.localOnly = localOnly
    writer.requestWrite()
  })

  // Meet fills the real meeting name in with a delay.
  setTimeout(() => {
    session.title = readMeetingTitle()
    writer.requestWrite()
  }, 7000)

  await enableCaptions()
  applyCaptionsVisibility(settings)
  watchSettings()

  void observeCaptions()
  void observeChat()
  hookMeetingEnd()
  showToast("Plática Notes is recording this meeting")

  // ---------- closures ----------

  async function observeCaptions(): Promise<void> {
    const region = await waitForSelector(CAPTIONS_REGION)
    let blockSeq = 0
    let lastSpeaker = ""
    let lastText = ""

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== "characterData") continue
        try {
          const textDiv = mutation.target.parentElement
          const wrapper = textDiv?.parentElement
          const siblings = [...(wrapper?.parentElement?.children ?? [])]
          // Meet keeps two service nodes at the end and rewrites older caption
          // blocks retroactively — only the third-from-last block is live speech.
          if (siblings.length < 3 || siblings[siblings.length - 3] !== wrapper) continue

          const speaker = textDiv?.previousSibling?.textContent ?? ""
          const text = textDiv?.textContent ?? ""

          if (!speaker || !text) {
            // Captions went quiet: close the open utterance.
            collector.closeCurrent()
            blockSeq++
            lastSpeaker = ""
            lastText = ""
            continue
          }

          const monologueReset = text.length - lastText.length < -MONOLOGUE_RESET_DROP
          if (speaker !== lastSpeaker || monologueReset) blockSeq++
          lastSpeaker = speaker
          lastText = text

          collector.update({
            blockKey: String(blockSeq),
            speaker: speaker === "You" ? selfName : speaker,
            text,
            at: new Date().toISOString(),
          })
          session.transcript = collector.snapshot()
          writer.requestWrite()
          pulseActivity()
        } catch (error) {
          console.error("[platica-notes] caption mutation:", error)
        }
      }
    })
    observer.observe(region, { childList: true, subtree: true, characterData: true })
  }

  async function observeChat(): Promise<void> {
    try {
      const chatButton = await withTimeout(waitForIcon(CHAT_ICON_TEXT), 30_000)
      if (!chatButton) return
      chatButton.click() // materialize the chat DOM once
      const list = await withTimeout(waitForSelector(CHAT_LIST), 10_000)
      chatButton.click() // close the panel again
      if (!list) return

      const observer = new MutationObserver(() => {
        try {
          const container = document.querySelector(CHAT_LIST)
          if (!container || container.children.length === 0) return
          const messageElement = container.lastChild?.firstChild?.firstChild?.lastChild
          const header = messageElement?.firstChild
          const sender =
            header?.childNodes.length === 1 ? selfName : header?.firstChild?.textContent
          const text =
            messageElement?.lastChild?.lastChild?.firstChild?.firstChild?.firstChild?.textContent
          if (!sender || !text) return
          if (chatLog.add({ sender, sentAt: new Date().toISOString(), text })) {
            session.chat = chatLog.snapshot()
            writer.requestWrite()
          }
        } catch (error) {
          console.error("[platica-notes] chat mutation:", error)
        }
      })
      observer.observe(list, { childList: true, subtree: true, characterData: true })
    } catch (error) {
      console.error("[platica-notes] chat observer not registered:", error)
    }
  }

  async function enableCaptions(): Promise<void> {
    // If captions are already on, the off-icon never appears — time out quietly.
    const icon = await withTimeout(waitForIcon(CAPTIONS_OFF_ICON_TEXT), 15_000)
    icon?.click()
  }

  function applyCaptionsVisibility(current: Settings): void {
    setCaptionsHidden(current.hideCaptionsOverlay)
  }

  function watchSettings(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.settings) {
        const next = withDefaults(changes.settings.newValue as Partial<Settings> | undefined)
        setCaptionsHidden(next.hideCaptionsOverlay)
      }
    })
  }

  function hookMeetingEnd(): void {
    const leaveIcon = findIcon(LEAVE_ICON_TEXT)
    const clickTarget = leaveIcon?.parentElement?.parentElement
    if (!clickTarget) {
      console.error("[platica-notes] leave button not found; relying on tab-close finalization")
      return
    }
    clickTarget.addEventListener("click", () => { void endMeeting() })
  }

  async function endMeeting(): Promise<void> {
    collector.closeCurrent()
    session.transcript = collector.snapshot()
    await writer.writeNow()
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) console.error("[platica-notes] finalize failed:", response.error)
  }
}

// ---------- module-level helpers ----------

function setCaptionsHidden(hidden: boolean): void {
  const existing = document.getElementById(HIDE_CAPTIONS_STYLE_ID)
  if (!hidden) {
    existing?.remove()
    return
  }
  if (existing) return
  const style = document.createElement("style")
  style.id = HIDE_CAPTIONS_STYLE_ID
  // opacity (not display:none): Meet must keep writing caption text into the DOM.
  style.textContent = `${CAPTIONS_REGION} { opacity: 0 !important; pointer-events: none !important; }`
  document.documentElement.appendChild(style)
}

function findIcon(text: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>(ICON_FONT)].find(
      (el) => el.textContent === text,
    ) ?? null
  )
}

async function waitForIcon(text: string): Promise<HTMLElement> {
  for (;;) {
    const el = findIcon(text)
    if (el) return el
    await tick()
  }
}

async function waitForSelector(selector: string): Promise<Element> {
  for (;;) {
    const el = document.querySelector(selector)
    if (el) return el
    await tick()
  }
}

/** rAF when visible, timer fallback when the tab is backgrounded. */
function tick(): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    delay(300),
  ])
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, delay(ms).then(() => null)])
}

async function captureSelfName(): Promise<string | null> {
  const el = await withTimeout(waitForSelector(SELF_NAME), 60_000)
  return el?.textContent?.trim() || null
}

function readMeetingTitle(): string {
  const titled = document.querySelector(MEETING_TITLE)?.textContent?.trim()
  return titled || document.title
}
