import { sendToBackground } from "../../shared/messages"
import { getLocal, getSettings, saveSettings, sessionKey, setLocal, withDefaults } from "../../shared/storage"
import { DEFAULT_SETTINGS } from "../../shared/types"
import type { ActiveSession, DebugEvent, Note, Settings } from "../../shared/types"
import { SessionWriter } from "../core/persistence"
import { isBookmarkChord, isHideUiChord } from "../core/hotkeys"
import { isUiHidden, mountMeetingControls, pulseActivity, setUiHidden, showToast } from "../core/ui"
import { mountTranscriptPanel } from "../core/transcript-panel"
import { RTC_CONFIG_EVENT, RTC_DEBUG_EVENT, RTC_EVENT } from "../meet-rtc/bridge"
import type { RtcCaptionEvent, RtcChatEvent, RtcEvent } from "../meet-rtc/bridge"
import { RtcFeed } from "../meet-rtc/feed"
import {
  nextLeaveState,
  nextMediaZeroSince,
  seedAttendees,
  shouldDrainTail,
  shouldEndFromMedia,
  shouldFinalizeStaleSession,
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
    if (parsed.type === "media") {
      // Route media-path liveness to the running meeting's end detector. Ignored
      // between meetings (onMediaState is null) — nothing to finalize.
      if (typeof parsed.openSessions === "number") onMediaState?.(parsed.openSessions)
      return
    }
    activeMeetingHandler?.(parsed)
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
    await runMeeting(tabId)
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
  const previous = await getLocal<ActiveSession>(sessionKey(tabId))
  if (shouldFinalizeStaleSession(previous?.path ?? null, meetingPath)) {
    dlog("finalizing a previous meeting's session before it is overwritten", {
      stalePath: previous!.path,
      path: meetingPath,
    })
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) {
      console.error("[platica-notes] stale-session finalize failed:", response.error)
      dlog("stale-session finalize failed", { error: response.error })
    }
  }

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
  }
  const prefixTranscript = resumed ? resumed.transcript : []
  const prefixChat = resumed ? resumed.chat : []
  // Debug from a resumed snapshot is prepended, mirroring transcript/chat.
  const prefixDebug = resumed?.debug ?? []
  // Attendees from a resumed snapshot seed the set (?? [] tolerates pre-feature snapshots).
  const prefixParticipants = resumed?.participants ?? []
  const prefixRawVersions = resumed?.rawVersions ?? []
  const prefixNotes = resumed?.notes ?? []

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
  }
  // A new meeting always starts in the default language; a resumed one keeps the
  // language it was captured with. Reset the live subscription so a previous
  // meeting's pill override (which is never persisted) does not carry over.
  activeLanguage = session.captionLanguage ?? settings.captionLanguage
  pushRtcConfig(activeLanguage, debugEnabled)

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
  const attendees = new Set<string>()
  recordAttendee = (name) => {
    const trimmed = name.trim()
    if (!trimmed || attendees.has(trimmed)) return
    attendees.add(trimmed)
    session.participants = [...attendees]
    writer.requestWrite()
  }
  // Seed from the roster known at join time. Roster device events stream from join
  // time — often before this wiring — so without seeding, participants who arrived
  // before the meeting's feed existed are missed from the list (they still resolve
  // as speakers via the page roster). Live arrivals after this are added above.
  for (const name of seedAttendees(prefixParticipants, [...roster.values()], selfName)) recordAttendee(name)

  // Recorder's notes/bookmarks for this meeting, seeded from a resumed snapshot.
  const notes: Note[] = [...prefixNotes]

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
    initialLanguage: session.captionLanguage ?? settings.captionLanguage,
    initialPrivate: session.isPrivate,
    onPrivateChange: (isPrivate) => {
      session.isPrivate = isPrivate
      writer.requestWrite()
    },
    // This-meeting-only override: resubscribe the live stream and snapshot the
    // language into the session (so a reload resumes in it), but do NOT persist
    // it to Settings — the next meeting must start from the default.
    onLanguageChange: (language) => {
      session.captionLanguage = language
      activeLanguage = language
      writer.requestWrite()
      pushRtcConfig(language, debugEnabled)
    },
    onToggleTranscript: () => panel.toggle(),
  })

  const panel = mountTranscriptPanel({
    onVisibilityChange: (open) => controls.setTranscriptActive(open),
    onAddNote: addNote,
  })
  panel.update(session.transcript, session.chat, session.notes ?? [])

  // Re-resolve speaker names (they resolve from the roster at snapshot time) and
  // push the fresh transcript to the panel. Invoked by the page-level roster
  // handler so a name learned mid-meeting appears without waiting for a caption.
  refreshTranscript = () => {
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    panel.update(session.transcript, session.chat, session.notes ?? [])
    writer.requestWrite()
  }

  // Append a timestamped note (empty text = a bare bookmark) to this meeting.
  // Reached from the panel's note input and the global Alt+Shift+B bookmark chord.
  function addNote(text: string): void {
    notes.push({ at: new Date().toISOString(), text: text.trim() })
    session.notes = [...notes]
    panel.update(session.transcript, session.chat, session.notes)
    writer.requestWrite()
    pulseActivity()
  }
  addNoteToActive = addNote

  // Meet fills the real meeting name in with a delay. Cleared in endMeeting so a
  // short meeting (<7s) leaves no stray timer firing after teardown.
  const titleTimer = setTimeout(() => {
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
      panel.update(session.transcript, session.chat, session.notes ?? [])
      writer.requestWrite()
      pulseActivity()
    } else if (event.type === "chat") {
      if (!feed.handleChat(event, new Date().toISOString())) return
      session.chat = [...prefixChat, ...feed.chatSnapshot()]
      // Chat now shares the live timeline, so reflect it in the panel (and pulse)
      // exactly like a caption.
      panel.update(session.transcript, session.chat, session.notes ?? [])
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
    clearTimeout(titleTimer)
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
    addNoteToActive = null
    onMediaState = null
    onDebugEvent = null
    controls.unmount()
    panel.unmount()
    // Final snapshot resolves speaker names from the roster as it stands now,
    // and includes anything the flush wait above let land.
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    session.rawVersions = [...prefixRawVersions, ...feed.versionsSnapshot()]
    session.chat = [...prefixChat, ...feed.chatSnapshot()]
    session.participants = [...attendees]
    session.notes = [...notes]
    // Capture the complete debug trail (including this "meeting ended") into the
    // final snapshot. Stays undefined when disabled — no behavioural change.
    if (debugEnabled) session.debug = [...prefixDebug, ...debugEvents.slice(debugStart)]
    await writer.writeNow()
    // Seal the writer: any late event/timer must not re-create the session key
    // the background is about to clean up in meetingEnded.
    writer.close()
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
      void saveSettings({ hideUi: !isUiHidden() })
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
