import { sendToBackground } from "../../shared/messages"
import { getLocal, getSettings, sessionKey, setLocal, withDefaults } from "../../shared/storage"
import type { ActiveSession, DebugEvent, Settings } from "../../shared/types"
import { SessionWriter } from "../core/persistence"
import { mountPrivacyPill, pulseActivity, showToast } from "../core/ui"
import { RTC_CONFIG_EVENT, RTC_DEBUG_EVENT, RTC_EVENT } from "../meet-rtc/bridge"
import type { RtcCaptionEvent, RtcChatEvent, RtcEvent } from "../meet-rtc/bridge"
import { RtcFeed } from "../meet-rtc/feed"

// --- Google Meet DOM contract. Verify on a live meeting before each release. ---
const ICON_FONT = ".google-symbols"
const LEAVE_ICON_TEXT = "call_end"
const MEETING_TITLE = ".u6vdEc"
// -------------------------------------------------------------------------------

const MEETING_PATH = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i
// The leave icon flickers during toolbar re-renders; only this many consecutive
// missing checks mean the user actually left the call.
const LEAVE_GONE_CHECKS = 3
const END_WATCH_INTERVAL_MS = 2000

// Roster events stream from join time — often before our leave-icon detection
// lands — so the deviceId → name map lives at page level and survives across
// meetings in the same tab. Transcript/chat events without an active meeting
// are dropped (nothing to attribute them to yet).
const roster = new Map<string, string>()
let activeMeetingHandler: ((event: RtcCaptionEvent | RtcChatEvent) => void) | null = null

// Optional debug trail. Like roster, the buffer lives for the whole tab; the
// active meeting slices its own window out of it and flushes via onDebugEvent.
let debugEnabled = false
const debugEvents: DebugEvent[] = []
let onDebugEvent: (() => void) | null = null

// Adapter's own lifecycle events: always to console, plus the debug buffer when
// enabled. Structured detail rides in `extra`.
function dlog(msg: string, extra?: Record<string, unknown>): void {
  console.log("[platica-notes]", msg, extra ?? "")
  if (!debugEnabled) return
  debugEvents.push({ t: new Date().toISOString(), ctx: "adapter", msg, ...(extra ?? {}) })
  onDebugEvent?.()
}

void main().catch((error) => console.error("[platica-notes]", error))

async function main(): Promise<void> {
  dlog("adapter loaded", { pathname: location.pathname })
  const tabIdResponse = await sendToBackground<number>({ kind: "getTabId" })
  if (!tabIdResponse.ok) {
    console.error("[platica-notes] could not get tab id:", tabIdResponse.error)
    dlog("could not get tab id", { error: tabIdResponse.error })
    return
  }
  const tabId = tabIdResponse.data

  document.addEventListener(RTC_DEBUG_EVENT, (event) => {
    try {
      if (!debugEnabled) return
      const detail = (event as CustomEvent).detail
      if (typeof detail !== "string") return
      const ev = JSON.parse(detail) as DebugEvent
      debugEvents.push(ev)
      onDebugEvent?.()
    } catch {
      /* a debug-collection failure must never affect capture */
    }
  })

  document.addEventListener(RTC_EVENT, (event) => {
    const detail = (event as CustomEvent).detail
    if (typeof detail !== "string") return
    let parsed: RtcEvent
    try {
      parsed = JSON.parse(detail) as RtcEvent
    } catch {
      return
    }
    if (parsed.type === "device") {
      if (typeof parsed.deviceId === "string" && parsed.deviceId && typeof parsed.deviceName === "string" && parsed.deviceName) roster.set(parsed.deviceId, parsed.deviceName)
      return
    }
    activeMeetingHandler?.(parsed)
  })

  // The MAIN-world script must know the caption language before its first
  // subscribe, so push the config before any meeting can start.
  const settings = await getSettings()
  debugEnabled = settings.debugLog
  pushRtcConfig(settings.captionLanguage, settings.debugLog)
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
  dlog("waiting to join", { path: meetingPath })

  // Abort the lobby wait if the user backs out without joining.
  const joined = await waitForIcon(
    LEAVE_ICON_TEXT,
    () => location.pathname !== meetingPath,
  )
  if (!joined) return
  dlog("meeting started", { tab: tabId })
  await sendToBackground({ kind: "meetingStarted" })

  const settings = await getSettings()
  let ending = false

  // This meeting's debug window starts here. Earlier events (e.g. MAIN-world
  // "installed") fall into the first meeting — acceptable.
  const debugStart = debugEvents.length

  // A mid-meeting reload must continue the same session, not erase it.
  const previous = await getLocal<ActiveSession>(sessionKey(tabId))
  const resumed = previous && previous.path === meetingPath ? previous : null
  if (resumed) dlog("resuming session after reload")
  const prefixTranscript = resumed ? resumed.transcript : []
  const prefixChat = resumed ? resumed.chat : []
  // Debug from a resumed snapshot is prepended, mirroring transcript/chat.
  const prefixDebug = resumed?.debug ?? []

  const session: ActiveSession = {
    platform: "meet",
    path: meetingPath,
    title: resumed ? resumed.title : document.title,
    startedAt: resumed ? resumed.startedAt : new Date().toISOString(),
    isPrivate: resumed ? resumed.isPrivate : settings.privateByDefault,
    transcript: prefixTranscript,
    chat: prefixChat,
  }
  // The page roster is shared in, so names resolve retroactively even for
  // participants whose roster entries arrived before this meeting's feed existed.
  const feed = new RtcFeed(roster)
  const writer = new SessionWriter<ActiveSession>(
    (snapshot) => setLocal({ [sessionKey(tabId)]: snapshot }),
    () => session,
  )
  writer.requestWrite()

  // Persist the debug trail through the same writer. Only active when enabled,
  // so session.debug stays undefined otherwise (nothing persisted).
  if (debugEnabled) {
    onDebugEvent = () => {
      if (!debugEnabled) return
      session.debug = [...prefixDebug, ...debugEvents.slice(debugStart)]
      writer.requestWrite()
    }
    onDebugEvent()
  }

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

  let firstCaptionLogged = false
  activeMeetingHandler = (event) => {
    if (event.type === "transcript") {
      if (!feed.handleCaption(event, new Date().toISOString())) return
      if (!firstCaptionLogged) {
        firstCaptionLogged = true
        dlog("captions are flowing")
      }
      session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
      writer.requestWrite()
      pulseActivity()
    } else if (event.type === "chat") {
      if (!feed.handleChat(event, new Date().toISOString())) return
      session.chat = [...prefixChat, ...feed.chatSnapshot()]
      writer.requestWrite()
    }
    // Unknown event types from future bridge versions are silently ignored.
  }

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
    dlog("meeting ended", { reason })
    clearInterval(endWatcher)
    document.removeEventListener("click", onDocumentClick, true)
    // Stop routing first: a caption event arriving after finalization would
    // re-create the session key the background just cleaned up. The page-level
    // RTC listener stays armed for the next meeting. Null onDebugEvent here too
    // so a late debug event can't resurrect the session.
    activeMeetingHandler = null
    onDebugEvent = null
    unmountPill()
    // Final snapshot resolves speaker names from the roster as it stands now.
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    // Capture the complete debug trail (including this "meeting ended") into the
    // final snapshot. Stays undefined when disabled — no behavioural change.
    if (debugEnabled) session.debug = [...prefixDebug, ...debugEvents.slice(debugStart)]
    await writer.writeNow()
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) {
      console.error("[platica-notes] finalize failed:", response.error)
      dlog("finalize failed", { error: response.error })
    }
    meetingDone()
  }
}

// ---------- module-level helpers ----------

function pushRtcConfig(captionLanguage: string, debug: boolean): void {
  document.dispatchEvent(
    new CustomEvent(RTC_CONFIG_EVENT, { detail: JSON.stringify({ captionLanguage, debug }) }),
  )
}

function watchSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      const next = withDefaults(changes.settings.newValue as Partial<Settings> | undefined)
      debugEnabled = next.debugLog
      // The MAIN-world script re-subscribes the caption stream on change.
      pushRtcConfig(next.captionLanguage, next.debugLog)
    }
  })
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

function readMeetingTitle(): string {
  const titled = document.querySelector(MEETING_TITLE)?.textContent?.trim()
  return titled || document.title
}
