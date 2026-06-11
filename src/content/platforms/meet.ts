import { sendToBackground } from "../../shared/messages"
import { getLocal, getSettings, sessionKey, setLocal, withDefaults } from "../../shared/storage"
import type { ActiveSession, Settings } from "../../shared/types"
import { ChatLog, TranscriptCollector } from "../core/collector"
import { SessionWriter } from "../core/persistence"
import { mountPrivacyPill, pulseActivity, showToast } from "../core/ui"

// --- Google Meet DOM contract. Verify on a live meeting before each release. ---
const ICON_FONT = ".google-symbols"
const LEAVE_ICON_TEXT = "call_end"
const CAPTIONS_OFF_ICON_TEXT = "closed_caption_off"
const CAPTIONS_REGION = 'div[role="region"][tabindex="0"]'
const CHAT_LIST = 'div[aria-live="polite"].Ge9Kpc'
const CHAT_TOGGLE = 'button[aria-label="Chat with everyone"]'
const SIDE_PANEL = 'aside[aria-label="Side panel"]'
const SELF_NAME = ".awLEm"
const MEETING_TITLE = ".u6vdEc"
// -------------------------------------------------------------------------------

const HIDE_CAPTIONS_STYLE_ID = "platica-hide-captions"
const HIDE_SIDE_PANEL_STYLE_ID = "platica-hide-sidepanel"
// Meet restarts very long captions of one speaker; a sharp text shrink signals it.
const MONOLOGUE_RESET_DROP = 250
const MEETING_PATH = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i
// The leave icon flickers during toolbar re-renders; only this many consecutive
// missing checks mean the user actually left the call.
const LEAVE_GONE_CHECKS = 3
const END_WATCH_INTERVAL_MS = 2000

void main().catch((error) => console.error("[platica-notes]", error))

async function main(): Promise<void> {
  console.log("[platica-notes] adapter loaded on", location.pathname)
  const tabIdResponse = await sendToBackground<number>({ kind: "getTabId" })
  if (!tabIdResponse.ok) {
    console.error("[platica-notes] could not get tab id:", tabIdResponse.error)
    return
  }
  const tabId = tabIdResponse.data
  watchSettings()

  // Meet soft-navigates without page loads (landing -> meeting, /new -> meeting,
  // leave screen -> rejoin), so one meeting per page lifetime is not enough:
  // keep watching this tab for meeting pages forever.
  for (;;) {
    await waitFor(() => MEETING_PATH.test(location.pathname))
    await runMeeting(tabId)
    // Re-arm only after the leave screen is gone (path change) or the user
    // rejoined the same meeting (leave icon back).
    await waitFor(() => !MEETING_PATH.test(location.pathname) || !!findIcon(LEAVE_ICON_TEXT))
  }
}

async function runMeeting(tabId: number): Promise<void> {
  const meetingPath = location.pathname
  console.log("[platica-notes] waiting to join", meetingPath)

  // Abort the lobby wait if the user backs out without joining.
  const joined = await waitForIcon(
    LEAVE_ICON_TEXT,
    () => location.pathname !== meetingPath,
  )
  if (!joined) return
  console.log("[platica-notes] meeting started, tab", tabId)
  await sendToBackground({ kind: "meetingStarted" })

  const settings = await getSettings()
  let selfName = "You"
  let ending = false
  void captureSelfName(() => ending).then((name) => { if (name) selfName = name })

  // A mid-meeting reload must continue the same session, not erase it.
  const previous = await getLocal<ActiveSession>(sessionKey(tabId))
  const resumed = previous && previous.path === meetingPath ? previous : null
  if (resumed) console.log("[platica-notes] resuming session after reload")
  const prefixTranscript = resumed ? resumed.transcript : []
  const prefixChat = resumed ? resumed.chat : []

  const session: ActiveSession = {
    platform: "meet",
    path: meetingPath,
    title: resumed ? resumed.title : document.title,
    startedAt: resumed ? resumed.startedAt : new Date().toISOString(),
    isPrivate: resumed ? resumed.isPrivate : settings.privateByDefault,
    transcript: prefixTranscript,
    chat: prefixChat,
  }
  const collector = new TranscriptCollector()
  const chatLog = new ChatLog()
  const observers: MutationObserver[] = []
  const writer = new SessionWriter<ActiveSession>(
    (snapshot) => setLocal({ [sessionKey(tabId)]: snapshot }),
    () => session,
  )
  writer.requestWrite()

  const unmountPill = mountPrivacyPill(session.isPrivate, (isPrivate) => {
    session.isPrivate = isPrivate
    writer.requestWrite()
  })

  // Meet fills the real meeting name in with a delay.
  setTimeout(() => {
    if (ending) return
    session.title = readMeetingTitle()
    writer.requestWrite()
  }, 7000)

  // Inject the hide style BEFORE enabling captions. enableCaptions() can block
  // for seconds (it waits for the toolbar, and times out entirely if captions
  // are already on), and the style must already be in place so the caption
  // overlay never flashes on screen during that window.
  setCaptionsHidden(settings.hideCaptionsOverlay)
  await enableCaptions()

  void observeCaptions()
  void observeChat()

  // --- meeting end detection -------------------------------------------------
  // Meet re-renders its toolbar (mute toggles, layout changes), replacing the
  // leave button node, so a listener bound to one node silently dies. Delegate
  // from the document instead, and back it up with a poller that catches ends
  // we never see a click for (keyboard shortcut, kicked, host ended call).
  let meetingDone!: () => void
  const done = new Promise<void>((resolve) => { meetingDone = resolve })

  const onDocumentClick = (event: Event) => {
    const target = event.target as Element | null
    const control = target?.closest('button, [role="button"]')
    const icon = control?.querySelector(ICON_FONT)
    if (icon?.textContent === LEAVE_ICON_TEXT) void endMeeting("leave click")
  }
  document.addEventListener("click", onDocumentClick, true)

  let leaveGoneCount = 0
  const endWatcher = setInterval(() => {
    if (location.pathname !== meetingPath) {
      void endMeeting("left meeting page")
      return
    }
    leaveGoneCount = findIcon(LEAVE_ICON_TEXT) ? 0 : leaveGoneCount + 1
    if (leaveGoneCount >= LEAVE_GONE_CHECKS) void endMeeting("call ended")
  }, END_WATCH_INTERVAL_MS)
  // ---------------------------------------------------------------------------

  showToast("Plática Notes is recording this meeting")
  await done
  return

  // ---------- closures ----------

  async function endMeeting(reason: string): Promise<void> {
    if (ending) return
    ending = true
    console.log("[platica-notes] meeting ended:", reason)
    clearInterval(endWatcher)
    document.removeEventListener("click", onDocumentClick, true)
    // Stop observing first: a caption mutation arriving after finalization
    // would re-create the session key the background just cleaned up.
    for (const observer of observers) observer.disconnect()
    unmountPill()
    collector.closeCurrent()
    session.transcript = [...prefixTranscript, ...collector.snapshot()]
    await writer.writeNow()
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) console.error("[platica-notes] finalize failed:", response.error)
    meetingDone()
  }

  async function observeCaptions(): Promise<void> {
    const region = await waitForSelector(CAPTIONS_REGION, () => ending)
    if (!region || ending) return
    console.log("[platica-notes] captions region found, observer attached")
    let blockSeq = 0
    let lastSpeaker = ""
    let lastText = ""
    let firstCaptureLogged = false

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
          if (!firstCaptureLogged) {
            firstCaptureLogged = true
            console.log("[platica-notes] captions are flowing")
          }
          session.transcript = [...prefixTranscript, ...collector.snapshot()]
          writer.requestWrite()
          pulseActivity()
        } catch (error) {
          console.error("[platica-notes] caption mutation:", error)
        }
      }
    })
    observer.observe(region, { childList: true, subtree: true, characterData: true })
    observers.push(observer)
  }

  async function observeChat(): Promise<void> {
    try {
      const chatButton = await withTimeout(
        waitForSelector(CHAT_TOGGLE, () => ending),
        30_000,
      )
      if (!chatButton || ending) return

      // Meet only builds the chat DOM once the side panel is opened. Hide the
      // panel first so this materialization toggle is invisible — the user
      // never sees the chat flash open and shut on join.
      hideSidePanel(true)
      ;(chatButton as HTMLElement).click() // open (offscreen)
      const list = await withTimeout(waitForSelector(CHAT_LIST, () => ending), 10_000)
      ;(chatButton as HTMLElement).click() // close again
      // The list node persists in the DOM after closing, so the observer below
      // keeps working. Reveal the panel again once it has collapsed.
      void waitForSidePanelClosed().then(() => hideSidePanel(false))
      if (!list || ending) {
        hideSidePanel(false)
        return
      }

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
            session.chat = [...prefixChat, ...chatLog.snapshot()]
            writer.requestWrite()
          }
        } catch (error) {
          console.error("[platica-notes] chat mutation:", error)
        }
      })
      observer.observe(list, { childList: true, subtree: true, characterData: true })
      observers.push(observer)
    } catch (error) {
      console.error("[platica-notes] chat observer not registered:", error)
    }
  }
}

// ---------- module-level helpers ----------

async function enableCaptions(): Promise<void> {
  // If captions are already on, the off-icon never appears — time out quietly.
  const icon = await withTimeout(waitForIcon(CAPTIONS_OFF_ICON_TEXT), 15_000)
  icon?.click()
}

function watchSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      const next = withDefaults(changes.settings.newValue as Partial<Settings> | undefined)
      setCaptionsHidden(next.hideCaptionsOverlay)
    }
  })
}

function hideSidePanel(hidden: boolean): void {
  const existing = document.getElementById(HIDE_SIDE_PANEL_STYLE_ID)
  if (!hidden) {
    existing?.remove()
    return
  }
  if (existing) return
  const style = document.createElement("style")
  style.id = HIDE_SIDE_PANEL_STYLE_ID
  style.textContent = `${SIDE_PANEL} { opacity: 0 !important; pointer-events: none !important; }`
  document.documentElement.appendChild(style)
}

async function waitForSidePanelClosed(): Promise<void> {
  // Give the close click time to land, then wait until the panel is gone.
  for (let i = 0; i < 40; i++) {
    if (!document.querySelector(SIDE_PANEL)) return
    await delay(100)
  }
}

function setCaptionsHidden(hidden: boolean): void {
  const existing = document.getElementById(HIDE_CAPTIONS_STYLE_ID)
  if (!hidden) {
    existing?.remove()
    return
  }
  if (existing) return
  const style = document.createElement("style")
  style.id = HIDE_CAPTIONS_STYLE_ID
  // opacity + collapsed height (not display:none): Meet must keep writing caption
  // text into the DOM, but the region must not occupy screen space either.
  style.textContent =
    `${CAPTIONS_REGION} { opacity: 0 !important; height: 0 !important; ` +
    `min-height: 0 !important; overflow: hidden !important; pointer-events: none !important; }`
  document.documentElement.appendChild(style)
}

function findIcon(text: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>(ICON_FONT)].find(
      (el) => el.textContent === text,
    ) ?? null
  )
}

async function waitForIcon(text: string, abort?: () => boolean): Promise<HTMLElement | null> {
  for (;;) {
    const el = findIcon(text)
    if (el) return el
    if (abort?.()) return null
    await tick()
  }
}

async function waitForSelector(selector: string, abort?: () => boolean): Promise<Element | null> {
  for (;;) {
    const el = document.querySelector(selector)
    if (el) return el
    if (abort?.()) return null
    await tick()
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await tick()
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

async function captureSelfName(abort: () => boolean): Promise<string | null> {
  const el = await withTimeout(waitForSelector(SELF_NAME, abort), 60_000)
  return el?.textContent?.trim() || null
}

function readMeetingTitle(): string {
  const titled = document.querySelector(MEETING_TITLE)?.textContent?.trim()
  return titled || document.title
}
