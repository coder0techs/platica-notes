// The Google Meet adapter: everything platform-specific about recording a Meet call.
// The session itself is run by core/session-runner.ts, which knows nothing about Meet.
//
// What lives here: Meet's DOM contract, the soft-nav loop, join/end detection, the
// two event transports (the MAIN-world RTC bridge and the embedded chat.google.com
// frame), the caption language push, and the page-level identity state that has to
// survive across meetings in one tab.

import { sendToBackground } from "../../shared/messages"
import type { BackgroundResponse } from "../../shared/messages"
import { getSettings, saveSettings, withDefaults } from "../../shared/storage"
import { DEFAULT_SETTINGS } from "../../shared/types"
import type { DebugEvent, Settings } from "../../shared/types"
import { isBookmarkChord, isHideUiChord } from "../core/hotkeys"
import { isUiHidden, setUiHidden, showPersistentNotice } from "../core/ui"
import { runSession } from "../core/session-runner"
import { RTC_CONFIG_EVENT, RTC_DEBUG_EVENT, RTC_EVENT } from "../capture/protocol"
import type { CaptureEvent, HealthEvent } from "../capture/protocol"
import type { PlatformAdapter } from "./adapter"
import { parseOwnChatMessage } from "../chatgoogle/parse"
import {
  MEET_CAPTION_RULES,
  nextLeaveState,
  nextMediaZeroSince,
  shouldDrainTail,
  shouldEndFromMedia,
  shouldFinishRearmWait,
} from "./meet-lifecycle"

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
// Authoritative end via the RTC media-path signal: once the open media-session
// count has been zero for this long, the call's media path is down. The grace
// absorbs a reconnect that briefly zeroes the count. Evidence-based (50 logs):
// genuine ends sit at zero and finalize in < 2 s; the one observed reconnect was
// make-before-break and never reached zero. Evaluated on the END_WATCH_INTERVAL_MS
// cadence, so effective latency is ~grace + one tick — well inside the tail budget.
const MEDIA_END_GRACE_MS = 5000
// A roster device seen within this window of a session's start is treated as the
// initial roster (or a reload re-sync), not a mid-meeting join — so those already
// present get no "joined" marker.
const JOIN_SETTLE_MS = 10000

// Roster events stream from join time — often before our leave-icon detection
// lands — so the deviceId → name map lives at page level and survives across
// meetings in the same tab. The running session borrows it (see runSession).
const roster = new Map<string, string>()
// URL of the embedded Google Chat frame (chat.google.com), forwarded up from the
// frame hook (chatgoogle/main.ts). Page-level so it survives across meetings in the
// tab; stamped into each session snapshot (snapshotFields) so it reaches the file.
let chatUrl: string | null = null
// The local user's own name (from the GetUser RPC). Kept at page level (it can
// arrive before a meeting's feed exists) for the attendee list and reload
// persistence. Speaker resolution does not use it: self's deviceId → name arrives
// as an ordinary roster event (from UpdateMeetingDevice), so self resolves through
// the roster like any participant.
let selfName: string | null = null
// Caption language the live stream is currently subscribed to. Seeded from the
// default setting, re-pushed at every new meeting, and overridden (in memory only)
// by the in-meeting language pill — never persisted, so a manual switch does not
// leak into the next meeting. watchSettings reads this to avoid clobbering an active
// pill choice when an unrelated setting changes.
let activeLanguage = DEFAULT_SETTINGS.captionLanguage
// Is a session running right now? Only watchSettings needs to know (so a default
// language change mid-meeting does not retarget the running call).
let sessionActive = false
// The running session's note sink, published by the runner so the page-level
// bookmark chord can reach it. Null between meetings.
let noteSink: ((text: string) => void) | null = null
// Set by watchMeetEnd; receives the open media-session count from the RTC layer so
// the running meeting can detect an authoritative end (count sustained at zero).
// Null between meetings — a stray media event then has no meeting to end.
let onMediaState: ((openSessions: number) => void) | null = null
// Latest capture-path state seen from the MAIN-world script. Page-level because the
// captions channel can come up BEFORE a session exists (both happen at join), and a
// session that missed the signal would otherwise raise a false "never started"
// alarm; the runner seeds itself from this through meetAdapter.initialHealth.
let lastChannelHealth: HealthEvent["code"] | null = null
// Tail-grace bookkeeping for the soft-nav loop: which meeting ended and when, so a
// same-code re-entry inside the grace drains the caption tail with no live session
// to catch it as a phantom duplicate. Set through meetAdapter.afterFinalize.
let lastMeetingPath = ""
let lastMeetingEndedAt = 0

// Optional debug trail. Like roster, the buffer lives for the whole tab; the
// active session slices its own window out of it and flushes via onDebugEvent.
let debugEnabled = false
const debugEvents: DebugEvent[] = []
let onDebugEvent: (() => void) | null = null

// Adapter's own lifecycle events: to the console and the debug buffer only when
// debug is enabled (quiet by default; genuine errors use console.error directly).
// Structured detail rides in `extra`.
function dlog(msg: string, extra?: Record<string, unknown>): void {
  if (!debugEnabled) return
  console.log("[platica-notes]", msg, extra ?? "")
  // Spread caller data first so framing fields (t, ctx, msg) always win on collision.
  debugEvents.push({ ...(extra ?? {}), t: new Date().toISOString(), ctx: "adapter", msg })
  onDebugEvent?.()
}

// Set once the extension context is invalidated (reload/update mid-meeting). From
// that point every chrome.* call is dead: writes are sealed at the SessionWriter,
// sendToBackground returns {invalidated:true} instead of throwing, and we show a
// one-time notice telling the user to reload. Idempotent — later failures are silent.
let contextInvalidated = false
function onContextInvalidated(): void {
  if (contextInvalidated) return
  contextInvalidated = true
  showPersistentNotice(
    "Plática Notes was updated and can't keep recording in this tab. " +
      "Reload the page (or rejoin the call) to resume recording and save this meeting.",
  )
}

/** Surface the reload notice if a background call failed on an orphaned context. */
function noteIfInvalidated(response: BackgroundResponse): void {
  if (!response.ok && response.invalidated) onContextInvalidated()
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

  // Page-level identity bookkeeping, for the whole tab lifetime: roster entries and
  // the self name arrive from join time onward, including before a session exists and
  // between meetings, and speaker names resolve out of this map at snapshot time.
  // Registered BEFORE the running session subscribes to the same events, so the map
  // is already current when the session's handler re-resolves the transcript.
  subscribeMeetEvents((event) => {
    if (event.type === "roster" || event.type === "roster-leave") {
      // Keep the name mapping even on a leave (Meet's roster state-6 leaf carries it)
      // so a departure can be attributed to a participant we never saw arrive.
      if (typeof event.speakerId === "string" && event.speakerId && typeof event.name === "string" && event.name) {
        roster.set(event.speakerId, event.name)
      }
      return
    }
    if (event.type === "self" && typeof event.name === "string" && event.name) {
      selfName = event.name
      return
    }
    // Media-path liveness reaches whichever end watcher is armed. Ignored between
    // meetings (onMediaState is null) — there is nothing to finalize.
    if (event.type === "liveness" && typeof event.openSessions === "number") {
      onMediaState?.(event.openSessions)
      return
    }
    // Remember the capture path's state so a session starting after the channel
    // opened does not think it never came up.
    if (event.type === "health") lastChannelHealth = event.code
  })

  // The MAIN-world script must know the caption language before its first
  // subscribe, so push the config before any meeting can start.
  const settings = await getSettings()
  debugEnabled = settings.debugLog
  activeLanguage = settings.captionLanguage
  pushRtcConfig(activeLanguage, settings.debugLog)
  setUiHidden(settings.hideUi)
  watchHotkeys()
  watchSettings()

  // Meet soft-navigates without page loads (landing -> meeting, /new -> meeting,
  // leave screen -> rejoin), so one meeting per page lifetime is not enough:
  // keep watching this tab for meeting pages forever.
  for (;;) {
    await waitFor(() => meetAdapter.isMeetingPage())
    const meetingPath = meetAdapter.meetingKey()
    if (!meetingPath) continue
    // Refuse to start a NEW session on the just-ended code while Meet is still
    // streaming the final caption tail (see CAPTION_TAIL_GRACE_MS). Drain it with
    // no active session, then re-check from the top: after the grace the check is
    // stale, so a genuine rejoin of the same code still runs normally.
    if (shouldDrainTail(meetingPath, lastMeetingPath, lastMeetingEndedAt, Date.now(), CAPTION_TAIL_GRACE_MS)) {
      await delay(CAPTION_TAIL_GRACE_MS)
      continue
    }
    sessionActive = true
    try {
      await runSession({
        tabId,
        adapter: meetAdapter,
        roster,
        getSelfName: () => selfName,
        setSelfName: (name) => {
          selfName = name
        },
        debug: {
          enabled: () => debugEnabled,
          events: () => debugEvents,
          onEvent: (cb) => {
            onDebugEvent = cb
          },
          log: dlog,
        },
        bindNoteSink: (sink) => {
          noteSink = sink
        },
        onContextInvalidated,
        noteIfInvalidated,
      })
    } finally {
      sessionActive = false
    }
    meetAdapter.afterFinalize?.(meetingPath)
    // The Leave click fires the end while Meet's toolbar (and the call_end icon) is
    // still on screen. Wait for the icon to actually disappear before re-arming,
    // otherwise the residual icon triggers an instant phantom re-join on Meet's
    // post-leave screen. But a fast rejoin puts the user back in the call before this
    // wait begins, so the icon is present again and never clears — an unbounded wait
    // here would block the loop forever and the rejoined session would never be
    // recorded. Cap it at the tail grace: once it elapses, the top-of-loop
    // shouldDrainTail paces the restart of the same code.
    const rearmStart = Date.now()
    await waitFor(() =>
      shouldFinishRearmWait(!findIcon(LEAVE_ICON_TEXT), Date.now() - rearmStart, CAPTION_TAIL_GRACE_MS),
    )
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
      // The default only seeds the live language while no meeting is running; an
      // active meeting keeps the pill's choice, so changing the default in the
      // popup mid-meeting does not retarget the current call. Always re-push so a
      // debug-flag toggle reaches the MAIN-world script.
      if (!sessionActive) activeLanguage = next.captionLanguage
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
      void saveSettings({ hideUi: !isUiHidden() })
    } else {
      noteSink?.("")
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

// ---------- the Meet platform adapter ----------

// Attach to Meet's two event transports and hand every canonical event to `on`.
// The caller owns what happens with them (page-level bookkeeping, or the running
// session); this owns only the transports.
function subscribeMeetEvents(on: (event: CaptureEvent) => void): () => void {
  const onRtcEvent = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (typeof detail !== "string") return
    let parsed: CaptureEvent
    try {
      parsed = JSON.parse(detail) as CaptureEvent
    } catch {
      return
    }
    on(parsed)
  }
  document.addEventListener(RTC_EVENT, onRtcEvent)

  // The local user's OWN outgoing chat never returns over the meeting page's
  // WebRTC channels — Google routes the in-meeting chat through an embedded
  // Google Chat frame (chat.google.com). Our MAIN-world hook in that frame
  // (chatgoogle/main.ts) reads the outgoing message text and postMessages it up
  // here. Validate the sender ORIGIN (only the chat frame may send these), then
  // feed it as a chat event attributed to self. Deduped on the topic id so a
  // retransmit of the same send counts once.
  const onFrameMessage = (event: MessageEvent): void => {
    if (event.origin !== "https://chat.google.com") return
    // The frame carries its own URL (the chat conversation link); keep the first
    // chat.google.com URL we see for the saved file's header.
    const data = event.data as { url?: unknown } | null
    if (data && typeof data.url === "string" && data.url.startsWith("https://chat.google.com") && !chatUrl) {
      chatUrl = data.url
    }
    const own = parseOwnChatMessage(event.data)
    if (!own) return
    on({
      type: "chat",
      speakerId: "self",
      text: own.text,
      sender: selfName ?? "You",
      messageId: `self-topic/${own.messageId ?? own.text}`,
    })
  }
  window.addEventListener("message", onFrameMessage)

  return () => {
    document.removeEventListener(RTC_EVENT, onRtcEvent)
    window.removeEventListener("message", onFrameMessage)
  }
}

// Meeting-end detection. Meet re-renders its toolbar (mute toggles, layout
// changes), replacing the leave button node, so a listener bound to one node
// silently dies: delegate from the document instead, and back it up with a poller
// that catches the ends we never see a click for (keyboard shortcut, kicked, host
// ended the call) plus the authoritative media-path signal.
function watchMeetEnd(onEnd: (reason: string) => void): () => void {
  const meetingPath = location.pathname

  const onDocumentClick = (event: Event): void => {
    const target = event.target as Element | null
    const control = target?.closest('button, [role="button"]')
    const icon = control?.querySelector(ICON_FONT)
    if (icon?.textContent === LEAVE_ICON_TEXT) onEnd("leave click")
  }
  document.addEventListener("click", onDocumentClick, true)

  // Authoritative RTC end: the MAIN-world script reports the open media-session
  // count; when it stays at zero past the grace, the call's media path is down.
  // The page-level routing feeds it here; the poller below makes the decision on
  // its existing cadence (no second timer). A reconnect that reopens a session
  // resets this to null, cancelling the pending end.
  let mediaZeroSince: number | null = null
  onMediaState = (openSessions) => {
    mediaZeroSince = nextMediaZeroSince(mediaZeroSince, openSessions, Date.now())
  }

  let leaveGoneCount = 0
  const endWatcher = setInterval(() => {
    if (shouldEndFromMedia(mediaZeroSince, Date.now(), MEDIA_END_GRACE_MS)) {
      onEnd("rtc: all media sessions closed")
      return
    }
    const decision = nextLeaveState(
      location.pathname !== meetingPath,
      !!findIcon(LEAVE_ICON_TEXT),
      leaveGoneCount,
      LEAVE_GONE_CHECKS,
    )
    leaveGoneCount = decision.goneCount
    if (decision.end) onEnd(decision.reason)
  }, END_WATCH_INTERVAL_MS)

  return () => {
    clearInterval(endWatcher)
    onMediaState = null
    document.removeEventListener("click", onDocumentClick, true)
  }
}

export const meetAdapter: PlatformAdapter = {
  id: "meet",
  capabilities: {
    chat: true,
    languageSwitch: "self",
    rawVersions: true,
    participantEvents: true,
    livenessEnd: true,
  },
  captionRules: MEET_CAPTION_RULES,
  timings: { captionFlushMs: CAPTION_FLUSH_MS, joinSettleMs: JOIN_SETTLE_MS },
  isMeetingPage: () => MEETING_PATH.test(location.pathname),
  meetingKey: () => (MEETING_PATH.test(location.pathname) ? location.pathname : null),
  // The leave icon appearing is what "in the call" means on Meet; abort fires when
  // the user backs out of the lobby.
  waitForJoin: async (abort) => !!(await waitForIcon(LEAVE_ICON_TEXT, abort)),
  watchEnd: (onEnd) => watchMeetEnd(onEnd),
  readTitle: () => readMeetingTitle(),
  meetingUrl: (key) => `https://meet.google.com${key}`,
  subscribe: (on) => subscribeMeetEvents(on),
  // Also updates the page-level language so watchSettings does not clobber a live
  // pill choice, whoever called this.
  setLanguage: (tag) => {
    activeLanguage = tag
    pushRtcConfig(tag, debugEnabled)
  },
  initialHealth: () => lastChannelHealth,
  snapshotFields: () => ({ chatUrl: chatUrl ?? undefined }),
  // Arm the caption-tail grace: a same-code re-entry inside the window drains
  // Meet's trailing revisions with no live session to catch them as phantoms.
  afterFinalize: (key) => {
    lastMeetingPath = key
    lastMeetingEndedAt = Date.now()
  },
}
