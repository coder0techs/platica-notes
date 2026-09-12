import { isContextInvalidatedError, sendToBackground } from "../../shared/messages"
import { toLiteEvent } from "../../shared/lite-log"
import type { BackgroundResponse } from "../../shared/messages"
import { getLocal, getSettings, saveSettings, sessionKey, setLocal, withDefaults } from "../../shared/storage"
import { DEFAULT_SETTINGS } from "../../shared/types"
import type { ActiveSession, DebugEvent, Note, ParticipantEvent, Settings } from "../../shared/types"
import { SessionWriter } from "../core/persistence"
import { isBookmarkChord, isHideUiChord } from "../core/hotkeys"
import { isUiHidden, mountLanguagePrompt, mountMeetingControls, pulseActivity, setUiHidden, showPersistentNotice, showToast } from "../core/ui"
import { mountTranscriptPanel } from "../core/transcript-panel"
import {
  RTC_CONFIG_EVENT,
  RTC_DEBUG_EVENT,
  RTC_EVENT,
  RTC_LITE_EVENT,
  RTC_RELAY_EVENT,
  RTC_RELAY_RESULT_EVENT,
} from "../meet-rtc/bridge"
import type {
  RelayCredentials,
  RtcCaptionEvent,
  RtcChatEvent,
  RtcConfig,
  RtcEvent,
  RtcRelayRequest,
  RtcRelayResult,
} from "../meet-rtc/bridge"
import { RtcFeed } from "../meet-rtc/feed"
import { parseOwnChatMessage } from "../chatgoogle/parse"
import {
  finalAttendees,
  isMidMeetingJoin,
  nextLeaveState,
  nextMediaZeroSince,
  seedAttendees,
  shouldAskLanguage,
  shouldDrainTail,
  shouldEndFromMedia,
  shouldFinalizeStaleSession,
  shouldFinishRearmWait,
  captureFault,
} from "./meet-lifecycle"

// --- Google Meet DOM contract. Verify on a live meeting before each release. ---
const ICON_FONT = ".google-symbols"
const LEAVE_ICON_TEXT = "call_end"
const MEETING_TITLE = ".u6vdEc"
//
// Second candidates for the same nodes, observed independently on Meet's own DOM.
// Not used: they are written down so the pre-release check has somewhere to go
// when a selector above stops matching, instead of starting the hunt from zero.
// Any of them may rot just as fast — re-verify before trusting one.
//
//   meeting title   `.uBRSj .u6vdEc.ouH3xe`   — disambiguates if `.u6vdEc` ever
//                                               matches more than one node
//   leave button    `[jsname="CQylAd"]`, `[aria-label="Leave call"]`
//                                             — independent of the icon ligature
//   post-call view  `.kJU3pb`                 — present once the call UI is gone
//   mic state       `button[jsname="hw0c9"][data-is-muted]`
//                                             — we do not track mute at all today
//   people panel    `.axUSnc`, `[jscontroller="izfDQc"]`
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
// Authoritative end via the RTC media-path signal: once the open media-session
// count has been zero for this long, the call's media path is down. The grace
// absorbs a reconnect that briefly zeroes the count. Evidence-based (50 logs):
// genuine ends sit at zero and finalize in < 2 s; the one observed reconnect was
// make-before-break and never reached zero. Evaluated on the END_WATCH_INTERVAL_MS
// cadence, so effective latency is ~grace + one tick — well inside the tail budget.
const MEDIA_END_GRACE_MS = 5000
// A roster device seen within this window of a meeting's start is treated as the
// initial roster (or a reload re-sync), not a mid-meeting join — so those already
// present get no "joined" marker. Measured from THIS runMeeting's start.
const JOIN_SETTLE_MS = 10000
// How long a meeting may run without capture ever asking Meet for captions before
// we say something. Generous on purpose: joining, negotiating the peer connection
// and routing the media-session channel all happen first, and a false alarm is
// worse than a late one. Deliberately NOT a timeout on captions arriving —
// nobody speaking is normal, and warning about it would train people to ignore
// the notice.
const CAPTURE_HEALTH_GRACE_MS = 45000
const CAPTURE_HEALTH_TICK_MS = 5000
// How long a meeting that DID subscribe may produce nothing before we say so.
// Much longer than the arming grace, because the innocent explanation (a room
// where nobody has spoken yet) is common and the faulty one is not. Five minutes
// of two or more people and not one caption is no longer plausibly a quiet room.
const CAPTURE_SILENT_GRACE_MS = 300000

// Roster events stream from join time — often before our leave-icon detection
// lands — so the deviceId → name map lives at page level and survives across
// meetings in the same tab. Transcript/chat events without an active meeting
// are dropped (nothing to attribute them to yet).
const roster = new Map<string, string>()
// URL of the embedded Google Chat frame (chat.google.com), forwarded up from the
// frame hook (chatgoogle/main.ts). Page-level so it survives across meetings in the
// tab; stamped into each session snapshot so it reaches the saved file's header.
let chatUrl: string | null = null
// The local user's own name (from the GetUser RPC). Kept at page level (it can
// arrive before a meeting's feed exists) for the attendee list and reload
// persistence. Speaker resolution does not use it: self's deviceId → name arrives
// as an ordinary roster device event (from UpdateMeetingDevice), so self resolves
// through the roster like any participant.
let selfName: string | null = null
// Caption language the live stream is currently subscribed to. Seeded from the
// default setting, reset to the default at every new meeting, and overridden
// (in memory only) by the in-meeting language pill — never persisted, so a
// manual switch does not leak into the next meeting. watchSettings reads this to
// avoid clobbering an active pill choice when an unrelated setting changes.
let activeLanguage = DEFAULT_SETTINGS.captionLanguage
let activeMeetingHandler: ((event: RtcCaptionEvent | RtcChatEvent) => void) | null = null
// Set by runMeeting; receives the open media-session count from the RTC layer so
// the running meeting can detect an authoritative end (count sustained at zero).
// Null between meetings — a stray media event then has no meeting to end.
let onMediaState: ((openSessions: number) => void) | null = null
// Set by runMeeting; appends a note/bookmark to the active meeting. Page-level so
// the global bookmark hotkey can reach the running meeting. Null between meetings.
let addNoteToActive: ((text: string) => void) | null = null
// Set by runMeeting; records a name into the active meeting's attendee set. Fed by
// roster device events and the self name. Meeting-scoped (not the page-level roster
// map) so names never bleed from a previous meeting in the same tab.
let recordAttendee: ((name: string) => void) | null = null
// Set by runMeeting; classifies a roster device event as a mid-meeting JOIN and,
// when it is one, appends a timestamped marker to the active meeting. Meeting-scoped
// (own known-device set + settle window) so the initial roster and reload re-sync do
// not produce markers. Null between meetings.
let recordDevice: ((deviceId: string, name: string) => void) | null = null
// Set by runMeeting; on a device removal (RtcDeviceLeaveEvent) appends a "leave"
// marker for a known participant. Meeting-scoped. Null between meetings.
let recordLeave: ((deviceId: string) => void) | null = null
// Set by runMeeting; re-resolves the live transcript (speaker names resolve from
// the roster at snapshot time) and pushes it to the panel. Called when a roster
// device event arrives so a name learned mid-meeting shows up in the panel without
// waiting for the next caption.
let refreshTranscript: (() => void) | null = null
// Set by the running meeting; the MAIN world calls it once the caption
// subscription goes out.
let onCaptureArmed: (() => void) | null = null

// Optional debug trail. Like roster, the buffer lives for the whole tab; the
// active meeting slices its own window out of it and flushes via onDebugEvent.
let debugEnabled = false
const debugEvents: DebugEvent[] = []
let onDebugEvent: (() => void) | null = null
// Bounds per-flush serialization cost on long debug sessions; oldest events
// drop first. Cap applied to the final slice, not the source buffer, so
// debugStart indices never drift (chosen approach for Fix 2).
const DEBUG_EVENTS_MAX = 5000

// The adapter learns whether debug is on only once getSettings() resolves, which
// is after "adapter loaded" and anything else that happens on the way there. The
// MAIN world already retains its early events for this reason; without the same
// here, the phase most worth reading when capture fails to start is the one that
// is missing. Retained until settings arrive, then kept or dropped.
let debugConfigSeen = false
const debugBacklog: DebugEvent[] = []
const DEBUG_BACKLOG_MAX = 500

// The lite trail. Same shape as the debug buffer above and deliberately separate
// from it, because this one is collected whether or not debug is switched on and
// is kept on every meeting, private ones included. It needs no backlog: nothing
// about it waits on settings, so it starts collecting at document_start.
const liteEvents: DebugEvent[] = []
let onLiteEvent: (() => void) | null = null
// Smaller cap than the debug buffer: this is stored for EVERY meeting in history
// rather than for the few where someone turned logging on. A meeting's worth of
// lifecycle events and the first frames of each channel sits far below it; the
// cap is there so a pathological reconnect loop cannot grow history without end.
const LITE_EVENTS_MAX = 2000

// Adapter's own lifecycle events: to the console and the debug buffer only when
// debug is enabled (quiet by default; genuine errors use console.error directly).
// Structured detail rides in `extra`.
function dlog(msg: string, extra?: Record<string, unknown>): void {
  // Spread caller data first so framing fields (t, ctx, msg) always win on collision.
  const event: DebugEvent = { ...(extra ?? {}), t: new Date().toISOString(), ctx: "adapter", msg }
  collectLite(event)
  if (!debugConfigSeen) {
    debugBacklog.push(event)
    if (debugBacklog.length > DEBUG_BACKLOG_MAX) debugBacklog.shift()
    return
  }
  if (!debugEnabled) return
  console.log("[platica-notes]", msg, extra ?? "")
  debugEvents.push(event)
  onDebugEvent?.()
}

// Put one event through the content-free filter and keep what survives. Called
// for the adapter's own events and for every event the MAIN world dispatches.
function collectLite(event: DebugEvent): void {
  try {
    const lite = toLiteEvent(event)
    if (!lite) return
    liteEvents.push({ ...lite, t: event.t, ctx: event.ctx } as DebugEvent)
    onLiteEvent?.()
  } catch {
    /* a diagnostics failure must never affect capture */
  }
}

/** Settings have arrived: keep the retained adapter events, or drop them. */
function settleDebugBacklog(enabled: boolean): void {
  debugConfigSeen = true
  if (enabled) {
    for (const event of debugBacklog) {
      console.log("[platica-notes]", event.msg, event)
      debugEvents.push(event)
    }
    onDebugEvent?.()
  }
  debugBacklog.length = 0
}

// Set once the extension context is invalidated (an update or a reload of the
// extension mid-meeting). From that point every chrome.* call from this script is
// dead and sendToBackground returns {invalidated:true} instead of throwing.
//
// What the user is told depends entirely on whether the meeting survived it, and
// the two cases are not variations of one message. With the relay wired the update
// is a non-event: capture never paused, the file will be written as usual, and the
// only honest thing to do is say so briefly and get out of the way — a persistent
// banner demanding a reload would be both wrong and expensive, because reloading
// is what drops the user out of the call. Without a relay nothing more can be
// saved, which is a state the user has to act on, so that one stays a banner.
// Idempotent — later failures are silent.
let contextInvalidated = false
function onContextInvalidated(recovered = false): void {
  if (contextInvalidated) return
  contextInvalidated = true
  dlog("extension context invalidated", { recovered })
  if (recovered) {
    showToast("Plática Notes updated. This meeting is still being transcribed.")
    return
  }
  showPersistentNotice(
    "Plática Notes was updated and can't save any more of this meeting. " +
      "Everything transcribed so far is kept. Reloading the page resumes capture, " +
      "but Meet will drop you from the call.",
  )
}

// --- persistence relay ------------------------------------------------------
// The transport that outlives an update. Set up at meeting start, while chrome.*
// still works, because after the update there is no way to set it up. See
// meet-rtc/main.ts for the far side and background/relay.ts for what gates it.
let relayCredentials: RelayCredentials | null = null
let relayRequestId = 0

// A relay round trip crosses two worlds and a service worker that may be asleep.
// Bounded so a lost reply cannot wedge the write chain: the writer treats a
// timeout as an ordinary failed write and tries again with the next snapshot.
const RELAY_TIMEOUT_MS = 10_000

/**
 * Persist a snapshot through the MAIN world. Resolves only once the background
 * has confirmed the write, so the caller can rely on it having landed.
 */
function relayPersist(snapshot: unknown, final: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = ++relayRequestId
    const onResult = (event: Event): void => {
      const detail = (event as CustomEvent).detail
      if (typeof detail !== "string") return
      let result: RtcRelayResult
      try {
        result = JSON.parse(detail) as RtcRelayResult
      } catch {
        return
      }
      // Replies are not ordered: ignore anything that is not ours.
      if (result.id !== id) return
      settle()
      if (result.ok) resolve()
      else reject(new Error(result.error ?? "relay refused the snapshot"))
    }
    const timer = setTimeout(() => {
      settle()
      reject(new Error("relay timed out"))
    }, RELAY_TIMEOUT_MS)
    function settle(): void {
      clearTimeout(timer)
      document.removeEventListener(RTC_RELAY_RESULT_EVENT, onResult)
    }
    document.addEventListener(RTC_RELAY_RESULT_EVENT, onResult)
    const request: RtcRelayRequest = { id, snapshot: JSON.stringify(snapshot), final }
    document.dispatchEvent(new CustomEvent(RTC_RELAY_EVENT, { detail: JSON.stringify(request) }))
  })
}

/**
 * Ask the background for this tab's capability token and hand it, with the
 * extension id, to the MAIN world. Both are things page context cannot obtain for
 * itself, which is what keeps the external channel from being open to anyone.
 *
 * Best-effort: a failure here costs the update-survival property, not the
 * meeting, so it is logged and capture carries on exactly as before.
 */
async function armRelay(tabId: number): Promise<void> {
  const response = await sendToBackground<string>({ kind: "registerRelayToken" })
  if (response.ok && typeof response.data === "string") {
    relayCredentials = { extensionId: chrome.runtime.id, token: response.data, tabId }
    dlog("relay armed", { tab: tabId })
    return
  }
  // Asking is exactly what an update breaks, so a second meeting in an orphaned
  // tab can never be issued a token. Keep the one from the first meeting: it is
  // scoped to this tab and the background keeps it until the tab closes.
  if (relayCredentials?.tabId === tabId) {
    dlog("relay kept from the previous meeting", { tab: tabId })
    return
  }
  relayCredentials = null
  dlog("relay not armed", { error: response.ok ? "no token returned" : response.error })
}

/**
 * Settings, or the last ones we managed to read.
 *
 * chrome.storage.sync is gone for good once this script is orphaned, and a
 * meeting must not fail to start over a preference. What the user last chose is
 * still true, so it is used; only a change made after the update is missed.
 */
let cachedSettings: Settings = DEFAULT_SETTINGS
async function readSettings(): Promise<Settings> {
  try {
    cachedSettings = await getSettings()
  } catch (error) {
    if (!isContextInvalidatedError(error)) throw error
    dlog("settings unreadable, using the last known ones")
  }
  return cachedSettings
}

/**
 * The session already under this tab's key, or nothing if it cannot be read.
 * Only used to decide whether a PREVIOUS meeting's session needs finalizing
 * first; an orphaned context has already relayed its own finalize, so the key it
 * would have found is normally gone anyway.
 */
async function readPreviousSession(tabId: number): Promise<ActiveSession | undefined> {
  try {
    return await getLocal<ActiveSession>(sessionKey(tabId))
  } catch (error) {
    if (!isContextInvalidatedError(error)) throw error
    return undefined
  }
}

/**
 * For writes nobody awaits (a setting toggled from a hotkey or a prompt). Losing
 * one to a dead context is not worth an unhandled rejection in the user's console
 * — the notice about the update has already been shown by then.
 */
function swallowIfOrphaned(error: unknown): void {
  if (isContextInvalidatedError(error)) return
  console.error("[platica-notes] settings write failed:", error)
}

/** Surface the reload notice if a background call failed on an orphaned context. */
function noteIfInvalidated(response: BackgroundResponse): void {
  if (!response.ok && response.invalidated) onContextInvalidated(false)
}

void main().catch((error) => console.error("[platica-notes]", error))

async function main(): Promise<void> {
  dlog("adapter loaded", { pathname: location.pathname })
  const tabIdResponse = await sendToBackground<number>({ kind: "getTabId" })
  if (!tabIdResponse.ok) {
    console.error("[platica-notes] could not get tab id:", tabIdResponse.error)
    dlog("could not get tab id", { error: tabIdResponse.error })
    noteIfInvalidated(tabIdResponse)
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

  document.addEventListener(RTC_LITE_EVENT, (event) => {
    try {
      const detail = (event as CustomEvent).detail
      if (typeof detail !== "string") return
      // Already filtered in the MAIN world; re-filtered here so the contract is
      // enforced on the side that persists it, not only on the side that sends.
      collectLite(JSON.parse(detail) as DebugEvent)
    } catch {
      /* a diagnostics failure must never affect capture */
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
        recordDevice?.(parsed.deviceId, parsed.deviceName)
        refreshTranscript?.()
      }
      return
    }
    if (parsed.type === "device-leave") {
      if (typeof parsed.deviceId === "string" && parsed.deviceId) {
        // Keep the name mapping (the state-6 leaf carries it) so recordLeave can
        // resolve the name even if this device was never seen present before.
        // Meet does not always broadcast a device's name while it is present: on a
        // live 2026-08-14 call two participants' names arrived for the first time
        // here, in their leave tombstones. So treat this as a naming event too —
        // record the attendee and re-resolve the transcript — or those speakers stay
        // "Speaker <tail>" in the panel and missing from the participant list.
        if (typeof parsed.deviceName === "string" && parsed.deviceName) {
          roster.set(parsed.deviceId, parsed.deviceName)
          recordAttendee?.(parsed.deviceName)
          refreshTranscript?.()
        }
        recordLeave?.(parsed.deviceId)
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
    if (parsed.type === "capture-armed") {
      // Meet has been asked for captions. Whether anyone speaks after this is
      // not our business; the health watchdog only cares that we got this far.
      onCaptureArmed?.()
      return
    }
    if (parsed.type === "media") {
      // Route media-path liveness to the running meeting's end detector. Ignored
      // between meetings (onMediaState is null) — nothing to finalize.
      if (typeof parsed.openSessions === "number") onMediaState?.(parsed.openSessions)
      return
    }
    activeMeetingHandler?.(parsed)
  })

  // The local user's OWN outgoing chat never returns over the meeting page's
  // WebRTC channels — Google routes the in-meeting chat through an embedded
  // Google Chat frame (chat.google.com). Our MAIN-world hook in that frame
  // (chatgoogle/main.ts) reads the outgoing message text and postMessages it up
  // here. Validate the sender ORIGIN (only the chat frame may send these), then
  // feed it as a chat event attributed to self. Deduped on the topic id so a
  // retransmit of the same send counts once.
  window.addEventListener("message", (event) => {
    if (event.origin !== "https://chat.google.com") return
    // The frame carries its own URL (the chat conversation link); keep the first
    // chat.google.com URL we see for the saved file's header.
    const data = event.data as { url?: unknown } | null
    if (data && typeof data.url === "string" && data.url.startsWith("https://chat.google.com") && !chatUrl) {
      chatUrl = data.url
    }
    const own = parseOwnChatMessage(event.data)
    if (!own) return
    activeMeetingHandler?.({
      type: "chat",
      deviceId: "self",
      text: own.text,
      sender: selfName ?? "You",
      messageId: `self-topic/${own.messageId ?? own.text}`,
    })
  })

  // The MAIN-world script must know the caption language before its first
  // subscribe, so push the config before any meeting can start.
  const settings = await readSettings()
  debugEnabled = settings.debugLog
  settleDebugBacklog(debugEnabled)
  activeLanguage = settings.captionLanguage
  pushRtcConfig(activeLanguage, settings.debugLog)
  setUiHidden(settings.hideUi)
  watchHotkeys()
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
    if (shouldDrainTail(meetingPath, lastMeetingPath, lastMeetingEndedAt, Date.now(), CAPTION_TAIL_GRACE_MS)) {
      await delay(CAPTION_TAIL_GRACE_MS)
      continue
    }
    try {
      await runMeeting(tabId)
    } catch (error) {
      // A raw chrome.* call that got through: it must not take the watch loop
      // with it, or this tab silently stops capturing for the rest of its life.
      if (!isContextInvalidatedError(error)) throw error
      console.warn("[platica-notes] meeting ended on an orphaned context")
      dlog("meeting ended on an orphaned context", { error: String(error) })
      onContextInvalidated(relayCredentials !== null)
    }
    lastMeetingPath = meetingPath
    lastMeetingEndedAt = Date.now()
    // The Leave click fires endMeeting while Meet's toolbar (and the call_end
    // icon) is still on screen. Wait for the icon to actually disappear before
    // re-arming, otherwise the residual icon triggers an instant phantom re-join
    // on Meet's post-leave screen. But a fast rejoin puts the user back in the
    // call before this wait begins, so the icon is present again and never
    // clears — an unbounded wait here would block the loop forever and the
    // rejoined session would never be recorded. Cap it at the tail grace: once it
    // elapses, the top-of-loop shouldDrainTail paces the restart of the same code.
    const rearmStart = Date.now()
    await waitFor(() =>
      shouldFinishRearmWait(!findIcon(LEAVE_ICON_TEXT), Date.now() - rearmStart, CAPTION_TAIL_GRACE_MS),
    )
  }
}

async function runMeeting(tabId: number): Promise<void> {
  const meetingPath = location.pathname
  dlog("waiting to join", { path: meetingPath })

  // The tab key holds at most one session. If it belongs to a DIFFERENT meeting,
  // that meeting's content script was torn down before it could finalize (left via
  // Meet's UI, then opened another call in this tab) — its transcript is still
  // intact under the key, but our first write below would overwrite and lose it.
  // Finalize it FIRST: the background commits the stored session to history + disk
  // and clears the key. Done before the join wait, so it is saved even if the user
  // backs out of this lobby — and before meetingStarted, so finalize's untrackTab
  // can't drop the tab we are about to re-track. A same-path session is a genuine
  // reload-resume of this meeting (handled below), not stale.
  const previous = await readPreviousSession(tabId)
  if (shouldFinalizeStaleSession(previous?.path ?? null, meetingPath)) {
    dlog("finalizing a previous meeting's session before it is overwritten", {
      stalePath: previous!.path,
      path: meetingPath,
    })
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) {
      console.error("[platica-notes] stale-session finalize failed:", response.error)
      dlog("stale-session finalize failed", { error: response.error })
      noteIfInvalidated(response)
    }
  }

  // Abort the lobby wait if the user backs out without joining.
  const joined = await waitForIcon(
    LEAVE_ICON_TEXT,
    () => location.pathname !== meetingPath,
  )
  if (!joined) return
  dlog("meeting started", { tab: tabId })
  noteIfInvalidated(await sendToBackground({ kind: "meetingStarted" }))

  const settings = await readSettings()
  let ending = false

  // This meeting's debug window starts here. Everything before it — including the
  // MAIN-world "installed" stamp, which is emitted at document_start — is outside
  // the slice, which is why no saved log ever carried a build number. The header
  // below puts the service facts INSIDE the window instead of hoping an earlier
  // event survives.
  const debugStart = debugEvents.length
  const liteStart = liteEvents.length
  dlog("meeting header", {
    extVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
    extCommit: typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev",
    extId: chrome.runtime?.id,
    meetingPath,
    tab: tabId,
    userAgent: navigator.userAgent,
    // Settings that decide what capture does, so a log can be read without also
    // having to ask what the settings were at the time.
    captionLanguage: settings.captionLanguage,
    favouriteLanguages: settings.favouriteLanguages,
    captionAlternatives: settings.captionAlternatives,
    mergeRejoins: settings.mergeRejoins,
    askLanguageEachMeeting: settings.askLanguageEachMeeting,
    privateByDefault: settings.privateByDefault,
    hideUi: settings.hideUi,
  })

  // A mid-meeting reload of the SAME meeting continues its session (read above),
  // rather than erasing it. A different-meeting session was already finalized and
  // its key cleared just above, so it never resumes here.
  const resumed = previous && previous.path === meetingPath ? previous : null
  if (resumed) dlog("resuming session after reload")
  // A full page reload resets the page-level roster/selfName, but Meet only
  // broadcasts the collections roster and fires GetUser at the initial join — not
  // after a reload — so neither is re-delivered to the resumed session. Re-seed
  // both from the snapshot, otherwise every speaker falls back to "Speaker N".
  if (resumed) {
    for (const [id, name] of Object.entries(resumed.roster ?? {})) roster.set(id, name)
    if (!selfName && resumed.selfName) selfName = resumed.selfName
    if (!chatUrl && resumed.chatUrl) chatUrl = resumed.chatUrl
  }
  const prefixTranscript = resumed ? resumed.transcript : []
  const prefixChat = resumed ? resumed.chat : []
  // Debug from a resumed snapshot is prepended, mirroring transcript/chat.
  const prefixDebug = resumed?.debug ?? []
  const prefixLite = resumed?.lite ?? []
  // Attendees from a resumed snapshot seed the set (?? [] tolerates pre-feature snapshots).
  const prefixParticipants = resumed?.participants ?? []
  const prefixRawVersions = resumed?.rawVersions ?? []
  const prefixNotes = resumed?.notes ?? []
  const prefixParticipantEvents = resumed?.participantEvents ?? []

  const session: ActiveSession = {
    platform: "meet",
    path: meetingPath,
    title: resumed ? resumed.title : readMeetingTitle(),
    startedAt: resumed ? resumed.startedAt : new Date().toISOString(),
    isPrivate: resumed ? resumed.isPrivate : settings.privateByDefault,
    captionLanguage: resumed?.captionLanguage ?? settings.captionLanguage,
    transcript: prefixTranscript,
    chat: prefixChat,
    participants: [...prefixParticipants],
    rawVersions: [...prefixRawVersions],
    notes: [...prefixNotes],
    participantEvents: [...prefixParticipantEvents],
    recording: resumed?.recording ?? true,
  }
  // Live capture gate. Persisted on the session so a reload-resume restores an Off
  // meeting instead of silently recording again.
  let recording = session.recording ?? true
  // A new meeting always starts in the default language; a resumed one keeps the
  // language it was captured with. Reset the live subscription so a previous
  // meeting's pill override (which is never persisted) does not carry over.
  activeLanguage = session.captionLanguage ?? settings.captionLanguage

  // Arm the relay before anything can need it. An update lands whenever the
  // service worker happens to be idle, which includes the first quiet second of
  // this meeting, so "later" is not a safe time to do this.
  await armRelay(tabId)
  pushRtcConfig(activeLanguage, debugEnabled)

  // The page roster is shared in, so names resolve retroactively even for
  // participants whose roster entries arrived before this meeting's feed existed.
  const feed = new RtcFeed(roster)
  // One builder for both transports and for the relayed finalize, so the snapshot
  // that survives an update is byte-for-byte the one that would have been stored.
  const snapshotNow = (): ActiveSession => ({
    ...session,
    roster: Object.fromEntries(roster),
    selfName: selfName ?? undefined,
    chatUrl: chatUrl ?? undefined,
  })
  const writer = new SessionWriter<ActiveSession>(
    (snapshot) => setLocal({ [sessionKey(tabId)]: snapshot }),
    // Stamp the current page-level roster and self name into every persisted
    // snapshot so a reload can re-seed them (see the resume block above).
    snapshotNow,
    1000,
    onContextInvalidated,
    // Where writes go once this script's own chrome.* handle is dead. Absent when
    // the relay could not be armed, in which case the writer seals as it used to.
    relayCredentials ? (snapshot) => relayPersist(snapshot, false) : undefined,
  )
  writer.requestWrite()

  // Meeting-scoped attendee set. Fed by roster device events and the self name
  // (both routed through the page-level RTC listener via recordAttendee). Deduped
  // by exact name, so a participant who reconnects with a new device id — or any
  // repeated roster broadcast — counts once.
  const attendees = new Set<string>()
  // The roster is not a complete attendee source (see finalAttendees): anyone Meet
  // never named while present would be missing from the list while their turns sit
  // in the transcript under a real name. So the persisted list is always the union
  // of the set and the transcript's own resolved speakers, recomputed wherever
  // either side can change.
  const syncParticipants = (): void => {
    session.participants = finalAttendees([...attendees], session.transcript.map((u) => u.speaker))
  }
  recordAttendee = (name) => {
    const trimmed = name.trim()
    if (!trimmed || attendees.has(trimmed)) return
    attendees.add(trimmed)
    syncParticipants()
    writer.requestWrite()
  }
  // Seed from the roster known at join time. Roster device events stream from join
  // time — often before this wiring — so without seeding, participants who arrived
  // before the meeting's feed existed are missed from the list (they still resolve
  // as speakers via the page roster). Live arrivals after this are added above.
  for (const name of seedAttendees(prefixParticipants, [...roster.values()], selfName)) recordAttendee(name)

  // Recorder's notes/bookmarks for this meeting, seeded from a resumed snapshot.
  const notes: Note[] = [...prefixNotes]

  // Join/leave markers, keyed by NAME not deviceId. Meet churns deviceIds — a
  // reconnect gives the same person a NEW deviceId while the old one tombstones —
  // so a deviceId-keyed model emitted a false "joined" (new id) AND a false "left"
  // (old id) for one person merely reconnecting. Instead we track the set of active
  // deviceIds PER NAME: a name JOINS when its set goes empty→non-empty (after the
  // settle window), LEAVES only when its set goes non-empty→empty (all their devices
  // gone). A reconnect keeps the set non-empty throughout, so it emits neither.
  // The settle window is measured from THIS run's start (a resumed session's
  // startedAt is far in the past, which would misclassify the reload re-sync).
  const joinWatchStart = Date.now()
  const participantEvents: ParticipantEvent[] = [...prefixParticipantEvents]
  const activeByName = new Map<string, Set<string>>()
  // Seed with everyone already present at join (page roster is deviceId→name).
  for (const [deviceId, name] of roster) {
    const set = activeByName.get(name) ?? new Set<string>()
    set.add(deviceId)
    activeByName.set(name, set)
  }

  // Always wire up onDebugEvent so an OFF→ON mid-meeting toggle starts flushing
  // immediately. The closure self-gates on debugEnabled — no cost when debug is
  // off for the entire meeting (session.debug stays undefined), and ON→OFF
  // freezes the trail because the guard returns before writing.
  // No gate, unlike onDebugEvent below: the lite trail is what a meeting keeps by
  // default, so the only thing bounding it is the cap.
  onLiteEvent = () => {
    session.lite = [...prefixLite, ...liteEvents.slice(liteStart)].slice(-LITE_EVENTS_MAX)
    writer.requestWrite()
  }
  onLiteEvent()

  onDebugEvent = () => {
    if (!debugEnabled) return
    // Cap the serialized slice to DEBUG_EVENTS_MAX so chrome.storage write size
    // stays bounded. Source buffer is uncapped; only the persisted view is trimmed.
    const slice = debugEvents.slice(debugStart)
    session.debug = [...prefixDebug, ...slice].slice(-DEBUG_EVENTS_MAX)
    writer.requestWrite()
  }
  onDebugEvent()

  // Set by the start-of-meeting language prompt below (null when not shown / once it
  // closes). Declared here so applyLanguage can close it on any language change.
  let languagePrompt: { unmount: () => void } | null = null
  // The ephemeral, this-meeting-only language switch shared by the pill and the
  // start-of-meeting prompt: resubscribe + snapshot into the session, never write
  // the persisted default (so the next meeting still starts from the default). Any
  // language change also closes the start prompt — once you've chosen (pill OR
  // prompt) the prompt has done its job, so it never lingers stale.
  const applyLanguage = (language: string): void => {
    session.captionLanguage = language
    activeLanguage = language
    writer.requestWrite()
    pushRtcConfig(language, debugEnabled)
    languagePrompt?.unmount()
    languagePrompt = null
  }

  // This half of the delivery funnel: what actually crossed into the isolated
  // world and what the feed did with it. The MAIN world counts the wire side.
  // Comparing the two is the point — a gap between dispatched and received is a
  // loss in the hop between worlds, which nothing would otherwise show.
  const funnel = { received: 0, applied: 0, ignored: 0, paused: 0 }

  // --- capture health ---------------------------------------------------------
  // Capture failing to start is currently silent: the meeting runs, the panel
  // stays empty, and the first anyone knows is a missing file afterwards. This
  // says something while there is still time to react. It does not claim to know
  // why, and it never fires on a quiet meeting — see shouldWarnCaptureIdle.
  let captureArmed = false
  let captureWarned = false
  // The notice never auto-dismisses, so it has to be taken down deliberately:
  // once if capture turns out to be fine after all, and again at the end of the
  // meeting. Without the second one it outlived its meeting and hung over the
  // next one in the same tab — which is how a meeting that was recording
  // perfectly came to be sitting under a warning that it was not.
  let captureNotice: { dismiss: () => void } | null = null
  const clearCaptureNotice = () => {
    captureNotice?.dismiss()
    captureNotice = null
  }
  const meetingStartedAt = Date.now()
  onCaptureArmed = () => {
    if (captureArmed) return
    captureArmed = true
    dlog("capture armed")
    // Armed late is still armed: retract a warning that has been overtaken.
    if (captureWarned) {
      dlog("capture health warning retracted")
      clearCaptureNotice()
    }
  }
  const captureHealthTimer = setInterval(() => {
    const fault = captureFault({
      armed: captureArmed,
      captionsSeen: funnel.received,
      attendees: attendees.size,
      elapsedMs: Date.now() - meetingStartedAt,
      graceMs: CAPTURE_HEALTH_GRACE_MS,
      silentGraceMs: CAPTURE_SILENT_GRACE_MS,
      warned: captureWarned,
      paused: !recording,
    })
    if (!fault) return
    captureWarned = true
    dlog("capture health warning", { fault, elapsedMs: Date.now() - meetingStartedAt })
    // Speech, specifically. The chat channel is independent and keeps working in
    // the one failure we have reproduced, so "nothing has been captured" would be
    // wrong — and the earlier draft went on to promise that whatever had been
    // captured was safe, which contradicted the sentence before it.
    captureNotice = showPersistentNotice(
      fault === "not-armed"
        ? "Plática Notes is not transcribing speech in this meeting. The usual cause is a " +
          "second meeting-recorder extension running in this tab — only one of them can " +
          "read Meet's captions. Turn the other one off and reload the tab."
        // Deliberately does not guess which: both causes are real, the user can
        // check one of them in seconds, and claiming the wrong one is worse than
        // naming both. Chat and notes are unaffected either way, so this says
        // speech rather than everything.
        : "Plática Notes has not captured any speech in this meeting. Either the spoken " +
          "language does not match the one set in the extension, or Google Meet has " +
          "changed something and this version cannot read its captions. Chat and notes " +
          "are still being saved. To report it, send the Diagnostics file from the " +
          "extension's history page: it records what capture did and holds none of " +
          "what was said.",
    )
  }, CAPTURE_HEALTH_TICK_MS)

  // Ask the MAIN world to re-announce whether capture is armed, now that the
  // listener above exists.
  //
  // It announces once, when the subscription goes out, and Meet can accept that
  // subscription within a second of page load — well before this point. Making
  // the announcement sticky and replaying it on a config push was not enough on
  // its own: runMeeting pushes config a hundred lines earlier than it installs
  // this listener, so the replay landed in the same void as the original. The
  // request has to come from *after* the listener, which is here.
  pushRtcConfig(activeLanguage, debugEnabled)

  const controls = mountMeetingControls({
    initialLanguage: session.captionLanguage ?? settings.captionLanguage,
    favouriteLanguages: settings.favouriteLanguages,
    initialPrivate: session.isPrivate,
    initialRecording: recording,
    onPrivateChange: (isPrivate) => {
      session.isPrivate = isPrivate
      writer.requestWrite()
    },
    onRecordingChange: (on) => {
      recording = on
      session.recording = on
      writer.requestWrite()
    },
    onPurge: () => purge(),
    // This-meeting-only override (see applyLanguage): resubscribe + snapshot into
    // the session, never persist to Settings — the next meeting starts from default.
    onLanguageChange: (language) => applyLanguage(language),
    onToggleTranscript: () => panel.toggle(),
  })

  const panel = mountTranscriptPanel({
    onVisibilityChange: (open) => controls.setTranscriptActive(open),
    onAddNote: addNote,
  })
  panel.update(session.transcript, session.chat, session.notes ?? [], session.participantEvents ?? [])

  // Opt-in, loud, NON-blocking prompt to confirm/switch the caption language at the
  // start of a fresh meeting (capture is already running in the default). Skipped on
  // a reload-resume and while all UI is hidden. Routes a switch through applyLanguage
  // (same ephemeral path as the pill) and keeps the pill in sync via setLanguage.
  if (shouldAskLanguage(settings.askLanguageEachMeeting, !!resumed, isUiHidden())) {
    languagePrompt = mountLanguagePrompt({
      initialLanguage: session.captionLanguage ?? settings.captionLanguage,
      favouriteLanguages: settings.favouriteLanguages,
      onPick: (language) => { applyLanguage(language); controls.setLanguage(language) },
      onDisableAsking: () => void saveSettings({ askLanguageEachMeeting: false }).catch(swallowIfOrphaned),
    })
  }

  // Re-resolve speaker names (they resolve from the roster at snapshot time) and
  // push the fresh transcript to the panel. Invoked by the page-level roster
  // handler so a name learned mid-meeting appears without waiting for a caption.
  refreshTranscript = () => {
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    syncParticipants()
    panel.update(session.transcript, session.chat, session.notes ?? [], session.participantEvents ?? [])
    writer.requestWrite()
  }

  const pushPresence = (name: string, kind: "join" | "leave"): void => {
    if (!recording) return
    participantEvents.push({ at: new Date().toISOString(), name: name.trim(), kind })
    session.participantEvents = [...participantEvents]
    panel.update(session.transcript, session.chat, session.notes ?? [], session.participantEvents)
    writer.requestWrite()
    pulseActivity()
  }

  // A roster device appeared. Add it to its name's active set; a name whose set was
  // EMPTY and goes non-empty after the settle window (and is not self) is a genuine
  // join. A reconnect (new deviceId while an old one is still active) keeps the set
  // non-empty → no marker.
  recordDevice = (deviceId, name) => {
    if (ending) return
    const set = activeByName.get(name) ?? new Set<string>()
    const wasActive = set.size > 0
    set.add(deviceId)
    activeByName.set(name, set)
    // isMidMeetingJoin's `alreadyKnown` is "this name already had an active device".
    const isJoin = isMidMeetingJoin(name, selfName, wasActive, Date.now() - joinWatchStart, JOIN_SETTLE_MS)
    dlog("device seen", { deviceId, name, wasActive, isJoin })
    if (isJoin) pushPresence(name, "join")
  }

  // A roster device was removed (tombstone). Drop it from its name's active set; a
  // name whose set goes EMPTY (all devices gone, not self) is a genuine leave. A
  // reconnect's stale-device tombstone leaves the set non-empty → no marker. The
  // `ending` guard suppresses the end-of-meeting teardown cascade (Meet drops every
  // device at once when the call ends). Timing note: Meet can lag the tombstone.
  recordLeave = (deviceId) => {
    if (ending) return
    const name = roster.get(deviceId)
    const set = name ? activeByName.get(name) : undefined
    if (!name || !set || !set.has(deviceId)) return
    set.delete(deviceId)
    dlog("device left", { deviceId, name, remaining: set.size })
    if (set.size > 0) return
    if (selfName && name === selfName) return
    pushPresence(name, "leave")
  }

  // Append a timestamped note (empty text = a bare bookmark) to this meeting.
  // Reached from the panel's note input and the global Alt+Shift+B bookmark chord.
  function addNote(text: string): void {
    if (!recording) {
      showToast("Transcribing is paused")
      return
    }
    notes.push({ at: new Date().toISOString(), text: text.trim() })
    session.notes = [...notes]
    panel.update(session.transcript, session.chat, session.notes, session.participantEvents ?? [])
    writer.requestWrite()
    pulseActivity()
  }
  addNoteToActive = addNote

  // Wipe everything captured in THIS meeting so far: the feed, the resumed prefixes,
  // and the notes/presence arrays. Persists the emptied session so a crash-resume or
  // the eventual finalize sees empty -> no file. activeByName (presence bookkeeping)
  // is left intact: it is live identity state, not saved content.
  function purge(): void {
    feed.reset()
    prefixTranscript.length = 0
    prefixChat.length = 0
    prefixRawVersions.length = 0
    notes.length = 0
    participantEvents.length = 0
    session.transcript = []
    session.chat = []
    session.rawVersions = []
    session.notes = []
    session.participantEvents = []
    panel.update(session.transcript, session.chat, session.notes, session.participantEvents)
    writer.requestWrite()
  }

  // Meet fills the real meeting name in with a delay. Cleared in endMeeting so a
  // short meeting (<7s) leaves no stray timer firing after teardown.
  const titleTimer = setTimeout(() => {
    if (ending) return
    session.title = readMeetingTitle()
    writer.requestWrite()
  }, 7000)

  let firstCaptionLogged = false
  activeMeetingHandler = (event) => {
    if (!recording && (event.type === "transcript" || event.type === "chat")) {
      // Dropped on purpose, but still counted: otherwise a paused meeting looks
      // exactly like a broken one in the numbers.
      if (event.type === "transcript") funnel.paused++
      return
    }
    if (event.type === "transcript") {
      funnel.received++
      if (!feed.handleCaption(event, new Date().toISOString())) {
        // Not a loss: an older revision of a line already held, which the feed
        // is supposed to reject. Counted so it is not mistaken for one.
        funnel.ignored++
        return
      }
      funnel.applied++
      if (!firstCaptionLogged) {
        firstCaptionLogged = true
        dlog("captions are flowing")
      }
      session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
      session.rawVersions = [...prefixRawVersions, ...feed.versionsSnapshot()]
      panel.update(session.transcript, session.chat, session.notes ?? [], session.participantEvents ?? [])
      writer.requestWrite()
      pulseActivity()
    } else if (event.type === "chat") {
      if (!feed.handleChat(event, new Date().toISOString())) return
      session.chat = [...prefixChat, ...feed.chatSnapshot()]
      // Chat now shares the live timeline, so reflect it in the panel (and pulse)
      // exactly like a caption.
      panel.update(session.transcript, session.chat, session.notes ?? [], session.participantEvents ?? [])
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

  // Authoritative RTC end: the MAIN-world script reports the open media-session
  // count; when it stays at zero past the grace, the call's media path is down.
  // The page-level routing feeds it here; the endWatcher below makes the decision
  // on its existing cadence (no second timer). A reconnect that reopens a session
  // resets this to null, cancelling the pending end.
  let mediaZeroSince: number | null = null
  onMediaState = (openSessions) => {
    mediaZeroSince = nextMediaZeroSince(mediaZeroSince, openSessions, Date.now())
  }

  let leaveGoneCount = 0
  const endWatcher = setInterval(() => {
    if (shouldEndFromMedia(mediaZeroSince, Date.now(), MEDIA_END_GRACE_MS)) {
      void endMeeting("rtc: all media sessions closed")
      return
    }
    const decision = nextLeaveState(
      location.pathname !== meetingPath,
      !!findIcon(LEAVE_ICON_TEXT),
      leaveGoneCount,
      LEAVE_GONE_CHECKS,
    )
    leaveGoneCount = decision.goneCount
    if (decision.end) void endMeeting(decision.reason)
  }, END_WATCH_INTERVAL_MS)
  // ---------------------------------------------------------------------------

  // The language prompt already says "recording in X" — skip the generic toast
  // when it's up, so the two don't stack on the same spot.
  if (!languagePrompt) showToast("Plática Notes is transcribing this meeting")
  await done
  return

  // ---------- closures ----------

  async function endMeeting(reason: string): Promise<void> {
    if (ending) return
    ending = true
    dlog("meeting ended", { reason, funnel })
    // Stop the end-detection machinery first so neither the poller nor a
    // residual leave click can re-enter during the flush wait below.
    clearInterval(endWatcher)
    clearInterval(captureHealthTimer)
    clearCaptureNotice()
    clearTimeout(titleTimer)
    document.removeEventListener("click", onDocumentClick, true)
    onCaptureArmed = null
    // Leave the page-level RTC routing attached and wait: Meet keeps streaming
    // the final caption revision for a couple of seconds after Leave (same
    // messageId, higher version), so the feed completes the closing sentence
    // before we snapshot. The `ending` guard above makes a concurrent
    // endMeeting call a no-op during this window.
    dlog("finalizing after caption flush", { reason })
    // Persist the current transcript BEFORE the flush wait. Meet can reload the
    // page right after Leave, tearing down this content script mid-wait before the
    // finalize below runs (observed: the first Leave produced no file, the session
    // resumed on the reload and only saved on the next Leave). Writing now means the
    // stored session is complete-so-far regardless.
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    session.chat = [...prefixChat, ...feed.chatSnapshot()]
    session.participantEvents = [...participantEvents]
    syncParticipants()
    writer.requestWrite()
    // Wait for Meet's trailing caption revisions, but ONLY while the media path is
    // still up. Once it drops (pc closed) no further captions can arrive, so there
    // is nothing to flush — finalize at once rather than sitting in the wait window
    // where a post-Leave reload can kill the finalize before it saves the file.
    const flushStart = Date.now()
    while (Date.now() - flushStart < CAPTION_FLUSH_MS) {
      if (mediaZeroSince !== null) break
      await delay(150)
    }
    // Now stop routing: a caption event arriving after finalization would
    // re-create the session key the background just cleaned up. The page-level
    // RTC listener stays armed for the next meeting. Null onDebugEvent here too
    // so a late debug event can't resurrect the session.
    activeMeetingHandler = null
    recordAttendee = null
    recordDevice = null
    recordLeave = null
    refreshTranscript = null
    addNoteToActive = null
    onMediaState = null
    onDebugEvent = null
    onLiteEvent = null
    controls.unmount()
    panel.unmount()
    languagePrompt?.unmount()
    // Final snapshot resolves speaker names from the roster as it stands now,
    // and includes anything the flush wait above let land.
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    session.rawVersions = [...prefixRawVersions, ...feed.versionsSnapshot()]
    session.chat = [...prefixChat, ...feed.chatSnapshot()]
    // Recomputed AFTER the final snapshot: the roster can learn a name in the leave
    // tombstones (the 2026-08-14 case), which re-resolves that speaker's turns here.
    syncParticipants()
    session.notes = [...notes]
    session.participantEvents = [...participantEvents]
    // Capture the complete debug trail (including this "meeting ended") into the
    // final snapshot. Stays undefined when disabled — no behavioural change.
    session.lite = [...prefixLite, ...liteEvents.slice(liteStart)].slice(-LITE_EVENTS_MAX)
    if (debugEnabled) session.debug = [...prefixDebug, ...debugEvents.slice(debugStart)]
    await writer.writeNow()
    // Seal the writer: any late event/timer must not re-create the session key
    // the background is about to clean up in meetingEnded.
    writer.close()
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) {
      // An update took the direct channel, but the relay reaches the NEW version,
      // so the meeting can still end the way it always does: file written on
      // leave, no reload, no rejoin. Try that BEFORE reporting anything — a red
      // error for a failure we then recover from is how a working build looks
      // broken on chrome://extensions.
      if (response.invalidated && relayCredentials) {
        try {
          await relayPersist(snapshotNow(), true)
          dlog("finalized over the relay")
          onContextInvalidated(true)
          meetingDone()
          return
        } catch (error) {
          dlog("relayed finalize failed", { error: String(error) })
        }
      }
      console.error("[platica-notes] finalize failed:", response.error)
      dlog("finalize failed", { error: response.error })
      noteIfInvalidated(response)
    }
    meetingDone()
  }
}

// ---------- module-level helpers ----------

function pushRtcConfig(captionLanguage: string, debug: boolean): void {
  // Credentials ride on every push, not just the first: the MAIN-world script is
  // reloaded with the page but the adapter is not, and a push that dropped them
  // would leave the far side unable to relay exactly when it is needed.
  const config: RtcConfig = { captionLanguage, debug }
  if (relayCredentials) config.relay = relayCredentials
  document.dispatchEvent(new CustomEvent(RTC_CONFIG_EVENT, { detail: JSON.stringify(config) }))
}

function watchSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      const next = withDefaults(changes.settings.newValue as Partial<Settings> | undefined)
      debugEnabled = next.debugLog
      // The default only seeds the live language while no meeting is running; an
      // active meeting keeps the pill's choice, so changing the default in the
      // popup mid-meeting does not retarget the current call. Always re-push so a
      // debug-flag toggle reaches the MAIN-world script.
      if (activeMeetingHandler === null) activeLanguage = next.captionLanguage
      pushRtcConfig(activeLanguage, next.debugLog)
      setUiHidden(next.hideUi)
    }
  })
}

// Page-level keyboard chords. Both are ignored while the user is typing (an
// input/textarea/select or any contenteditable, e.g. Meet's chat or our note
// box) so a chord never eats a real keystroke.
// - Alt+Shift+H toggles all on-screen extension UI. Writes the persisted setting
//   (not just local state) so the popup checkbox and the chord stay in sync; the
//   change is applied by watchSettings. Works while the UI is hidden — the point.
// - Alt+Shift+B drops a bare bookmark into the running meeting (no-op if none).
function watchHotkeys(): void {
  document.addEventListener("keydown", (event) => {
    // Ignore key autorepeat so holding the chord is one action, not a burst of
    // sync-storage writes (hide-UI flicker) or duplicate bookmarks in the file.
    if (event.repeat) return
    const isHide = isHideUiChord(event)
    const isBookmark = isBookmarkChord(event)
    if (!isHide && !isBookmark) return
    const target = event.target as HTMLElement | null
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
    event.preventDefault()
    if (isHide) {
      void saveSettings({ hideUi: !isUiHidden() }).catch(swallowIfOrphaned)
    } else {
      addNoteToActive?.("")
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
