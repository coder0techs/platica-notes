import { sendToBackground } from "../../shared/messages"
import { getLocal, getSettings, saveSettings, sessionKey, setLocal, withDefaults } from "../../shared/storage"
import type { ActiveSession, DebugEvent, Settings } from "../../shared/types"
import { SessionWriter } from "../core/persistence"
import { mountMeetingControls, pulseActivity, showToast } from "../core/ui"
import { mountTranscriptPanel } from "../core/transcript-panel"
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
// Meet keeps the captions data channel open for a few seconds after Leave and
// keeps streaming the final caption revision. A same-code re-entry within this
// window would start a fresh session that catches that tail as a phantom
// duplicate, so we refuse to start one until the tail has drained.
const CAPTION_TAIL_GRACE_MS = 8000
// Meet streams the final caption revision for a couple of seconds after Leave;
// keep the feed receiving this long before finalizing so the closing sentence
// isn't saved truncated.
const CAPTION_FLUSH_MS = 2500

// Roster events stream from join time — often before our leave-icon detection
// lands — so the deviceId → name map lives at page level and survives across
// meetings in the same tab. Transcript/chat events without an active meeting
// are dropped (nothing to attribute them to yet).
const roster = new Map<string, string>()
// The local user's own name (from the GetUser RPC). Kept at page level (it can
// arrive before a meeting's feed exists) for the attendee list and reload
// persistence. Speaker resolution does not use it: self's deviceId → name arrives
// as an ordinary roster device event (from UpdateMeetingDevice), so self resolves
// through the roster like any participant.
let selfName: string | null = null
let activeMeetingHandler: ((event: RtcCaptionEvent | RtcChatEvent) => void) | null = null
// Set by runMeeting; records a name into the active meeting's attendee set. Fed by
// roster device events and the self name. Meeting-scoped (not the page-level roster
// map) so names never bleed from a previous meeting in the same tab.
let recordAttendee: ((name: string) => void) | null = null
// Set by runMeeting; re-resolves the live transcript (speaker names resolve from
// the roster at snapshot time) and pushes it to the panel. Called when a roster
// device event arrives so a name learned mid-meeting shows up in the panel without
// waiting for the next caption.
let refreshTranscript: (() => void) | null = null

// Optional debug trail. Like roster, the buffer lives for the whole tab; the
// active meeting slices its own window out of it and flushes via onDebugEvent.
let debugEnabled = false
const debugEvents: DebugEvent[] = []
let onDebugEvent: (() => void) | null = null
// Bounds per-flush serialization cost on long debug sessions; oldest events
// drop first. Cap applied to the final slice, not the source buffer, so
// debugStart indices never drift (chosen approach for Fix 2).
const DEBUG_EVENTS_MAX = 5000

// Adapter's own lifecycle events: always to console, plus the debug buffer when
// enabled. Structured detail rides in `extra`.
function dlog(msg: string, extra?: Record<string, unknown>): void {
  console.log("[platica-notes]", msg, extra ?? "")
  if (!debugEnabled) return
  // Spread caller data first so framing fields (t, ctx, msg) always win on collision.
  debugEvents.push({ ...(extra ?? {}), t: new Date().toISOString(), ctx: "adapter", msg })
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
      if (typeof parsed.deviceId === "string" && parsed.deviceId && typeof parsed.deviceName === "string" && parsed.deviceName) {
        roster.set(parsed.deviceId, parsed.deviceName)
        recordAttendee?.(parsed.deviceName)
        refreshTranscript?.()
      }
      return
    }
    if (parsed.type === "self") {
      // Store at page level (it can arrive before any meeting) and push into the
      // live feed if a meeting is already running.
      if (typeof parsed.name === "string" && parsed.name) {
        selfName = parsed.name
        recordAttendee?.(parsed.name)
      }
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
  let lastMeetingPath = ""
  let lastMeetingEndedAt = 0
  for (;;) {
    await waitFor(() => MEETING_PATH.test(location.pathname))
    const meetingPath = location.pathname
    // Refuse to start a NEW session on the just-ended code while Meet is still
    // streaming the final caption tail (see CAPTION_TAIL_GRACE_MS). Drain it with
    // no active session, then re-check from the top: after the grace the check is
    // stale, so a genuine rejoin of the same code still runs normally.
    if (meetingPath === lastMeetingPath && Date.now() - lastMeetingEndedAt < CAPTION_TAIL_GRACE_MS) {
      await delay(CAPTION_TAIL_GRACE_MS)
      continue
    }
    await runMeeting(tabId)
    lastMeetingPath = meetingPath
    lastMeetingEndedAt = Date.now()
    // The Leave click fires endMeeting while Meet's toolbar (and the call_end
    // icon) is still on screen. Wait for the icon to actually disappear before
    // re-arming, otherwise the residual icon triggers an instant phantom re-join
    // on Meet's post-leave screen. Once gone, the top-of-loop wait re-detects the
    // next meeting (soft-nav to a new code, or a rejoin of the same code when the
    // icon returns).
    await waitFor(() => !findIcon(LEAVE_ICON_TEXT))
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
  // A full page reload resets the page-level roster/selfName, but Meet only
  // broadcasts the collections roster and fires GetUser at the initial join — not
  // after a reload — so neither is re-delivered to the resumed session. Re-seed
  // both from the snapshot, otherwise every speaker falls back to "Speaker N".
  if (resumed) {
    for (const [id, name] of Object.entries(resumed.roster ?? {})) roster.set(id, name)
    if (!selfName && resumed.selfName) selfName = resumed.selfName
  }
  const prefixTranscript = resumed ? resumed.transcript : []
  const prefixChat = resumed ? resumed.chat : []
  // Debug from a resumed snapshot is prepended, mirroring transcript/chat.
  const prefixDebug = resumed?.debug ?? []
  // Attendees from a resumed snapshot seed the set (?? [] tolerates pre-feature snapshots).
  const prefixParticipants = resumed?.participants ?? []
  const prefixRawVersions = resumed?.rawVersions ?? []

  const session: ActiveSession = {
    platform: "meet",
    path: meetingPath,
    title: resumed ? resumed.title : readMeetingTitle(),
    startedAt: resumed ? resumed.startedAt : new Date().toISOString(),
    isPrivate: resumed ? resumed.isPrivate : settings.privateByDefault,
    transcript: prefixTranscript,
    chat: prefixChat,
    participants: [...prefixParticipants],
    rawVersions: [...prefixRawVersions],
  }
  // The page roster is shared in, so names resolve retroactively even for
  // participants whose roster entries arrived before this meeting's feed existed.
  const feed = new RtcFeed(roster)
  const writer = new SessionWriter<ActiveSession>(
    (snapshot) => setLocal({ [sessionKey(tabId)]: snapshot }),
    // Stamp the current page-level roster and self name into every persisted
    // snapshot so a reload can re-seed them (see the resume block above).
    () => ({ ...session, roster: Object.fromEntries(roster), selfName: selfName ?? undefined }),
  )
  writer.requestWrite()

  // Meeting-scoped attendee set. Fed by roster device events and the self name
  // (both routed through the page-level RTC listener via recordAttendee). Deduped
  // by exact name, so a participant who reconnects with a new device id — or any
  // repeated roster broadcast — counts once.
  const attendees = new Set<string>(prefixParticipants)
  recordAttendee = (name) => {
    const trimmed = name.trim()
    if (!trimmed || attendees.has(trimmed)) return
    attendees.add(trimmed)
    session.participants = [...attendees]
    writer.requestWrite()
  }
  if (selfName) recordAttendee(selfName)

  // Always wire up onDebugEvent so an OFF→ON mid-meeting toggle starts flushing
  // immediately. The closure self-gates on debugEnabled — no cost when debug is
  // off for the entire meeting (session.debug stays undefined), and ON→OFF
  // freezes the trail because the guard returns before writing.
  onDebugEvent = () => {
    if (!debugEnabled) return
    // Cap the serialized slice to DEBUG_EVENTS_MAX so chrome.storage write size
    // stays bounded. Source buffer is uncapped; only the persisted view is trimmed.
    const slice = debugEvents.slice(debugStart)
    session.debug = [...prefixDebug, ...slice].slice(-DEBUG_EVENTS_MAX)
    writer.requestWrite()
  }
  onDebugEvent()

  const controls = mountMeetingControls({
    initialLanguage: settings.captionLanguage,
    initialPrivate: session.isPrivate,
    onPrivateChange: (isPrivate) => {
      session.isPrivate = isPrivate
      writer.requestWrite()
    },
    // Writes the global captionLanguage; the watchSettings listener picks up the
    // chrome.storage change and resubscribes the live caption stream.
    onLanguageChange: (language) => { void saveSettings({ captionLanguage: language }) },
    onToggleTranscript: () => panel.toggle(),
  })

  const panel = mountTranscriptPanel({
    onVisibilityChange: (open) => controls.setTranscriptActive(open),
  })
  panel.update(session.transcript, session.chat)

  // Re-resolve speaker names (they resolve from the roster at snapshot time) and
  // push the fresh transcript to the panel. Invoked by the page-level roster
  // handler so a name learned mid-meeting appears without waiting for a caption.
  refreshTranscript = () => {
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    panel.update(session.transcript, session.chat)
    writer.requestWrite()
  }

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
      session.rawVersions = [...prefixRawVersions, ...feed.versionsSnapshot()]
      panel.update(session.transcript, session.chat)
      writer.requestWrite()
      pulseActivity()
    } else if (event.type === "chat") {
      if (!feed.handleChat(event, new Date().toISOString())) return
      session.chat = [...prefixChat, ...feed.chatSnapshot()]
      // Chat now shares the live timeline, so reflect it in the panel (and pulse)
      // exactly like a caption.
      panel.update(session.transcript, session.chat)
      writer.requestWrite()
      pulseActivity()
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
    // Stop the end-detection machinery first so neither the poller nor a
    // residual leave click can re-enter during the flush wait below.
    clearInterval(endWatcher)
    document.removeEventListener("click", onDocumentClick, true)
    // Leave the page-level RTC routing attached and wait: Meet keeps streaming
    // the final caption revision for a couple of seconds after Leave (same
    // messageId, higher version), so the feed completes the closing sentence
    // before we snapshot. The `ending` guard above makes a concurrent
    // endMeeting call a no-op during this window.
    dlog("finalizing after caption flush", { reason })
    await delay(CAPTION_FLUSH_MS)
    // Now stop routing: a caption event arriving after finalization would
    // re-create the session key the background just cleaned up. The page-level
    // RTC listener stays armed for the next meeting. Null onDebugEvent here too
    // so a late debug event can't resurrect the session.
    activeMeetingHandler = null
    recordAttendee = null
    refreshTranscript = null
    onDebugEvent = null
    controls.unmount()
    panel.unmount()
    // Final snapshot resolves speaker names from the roster as it stands now,
    // and includes anything the flush wait above let land.
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    session.rawVersions = [...prefixRawVersions, ...feed.versionsSnapshot()]
    session.chat = [...prefixChat, ...feed.chatSnapshot()]
    session.participants = [...attendees]
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
  // Meet prefixes document.title with "Meet - " once you have been in the call
  // (so rejoins and same-tab soft-nav meetings would otherwise be saved as
  // "Meet - <code>"). Strip it so the title is the bare meeting name/code.
  return (titled || document.title).replace(/^Meet - /, "")
}
