// One meeting, start to finish, with no knowledge of any platform: session start and
// reload-resume, the live feed, the on-screen controls and panel, attendee and
// presence bookkeeping, notes, the debug trail, and finalize. Everything
// platform-specific arrives through a PlatformAdapter.
//
// This was runMeeting() inside platforms/meet.ts. The ordering here was paid for in
// production bugs — see the ORDERING block below before changing any of it.

import { sendToBackground } from "../../shared/messages"
import type { BackgroundResponse } from "../../shared/messages"
import { getLocal, getSettings, saveSettings, sessionKey, setLocal } from "../../shared/storage"
import type { ActiveSession, DebugEvent, Note, ParticipantEvent } from "../../shared/types"
import type { CaptureEvent } from "../capture/protocol"
import type { PlatformAdapter } from "../platforms/adapter"
import { CaptureFeed } from "./feed"
import { healthMessage, isAlarming, nextHealth, type Health, type HealthInput } from "./health"
import { SessionWriter } from "./persistence"
import { isMidMeetingJoin, seedAttendees, shouldAskLanguage, shouldFinalizeStaleSession } from "./session-lifecycle"
import { isUiHidden, mountLanguagePrompt, mountMeetingControls, pulseActivity, showPersistentNotice, showToast } from "./ui"
import { mountTranscriptPanel } from "./transcript-panel"

// Bounds per-flush serialization cost on long debug sessions; oldest events drop
// first. Applied to the final slice, not the source buffer, so debugStart indices
// never drift.
const DEBUG_EVENTS_MAX = 5000

// Poll interval while waiting out the post-call flush window.
const FLUSH_POLL_MS = 150

// Cadence for the health fold's clock input. Only the initial "did the capture
// channel ever come up" wait needs it, so it can be lazy.
const HEALTH_TICK_MS = 2000

// Meet fills the real meeting name in with a delay, so the title is re-read once
// after this long. Cleared on finalize, so a short meeting leaves no stray timer.
const TITLE_RETRY_MS = 7000

/** The page-level context a runner borrows from its platform bundle. */
export interface RunnerDeps {
  tabId: number
  adapter: PlatformAdapter
  /**
   * speakerId -> name, owned by the platform bundle and shared across meetings in
   * the tab: roster events stream from join time, often before a session exists, and
   * speaker names resolve out of this map at snapshot time.
   */
  roster: Map<string, string>
  getSelfName: () => string | null
  setSelfName: (name: string) => void
  /** The platform bundle's debug ring buffer and flag. */
  debug: {
    enabled: () => boolean
    events: () => DebugEvent[]
    /** Register (or clear) the "a debug event landed" callback. */
    onEvent: (cb: (() => void) | null) => void
    log: (msg: string, extra?: Record<string, unknown>) => void
  }
  /**
   * Publish this session's note sink so a page-level hotkey can reach the running
   * meeting; called with null on finalize.
   */
  bindNoteSink: (sink: ((text: string) => void) | null) => void
  onContextInvalidated: () => void
  noteIfInvalidated: (response: BackgroundResponse) => void
}

/**
 * Run ONE meeting to completion. Resolves once the meeting has been finalized.
 *
 * ORDERING — every item below exists because it broke once:
 *  1. The stale-session finalize happens BEFORE the join wait and BEFORE
 *     meetingStarted, or a different meeting's transcript is overwritten and lost.
 *  2. The transcript is persisted BEFORE the flush wait, or a post-leave page reload
 *     tears this script down mid-wait and the file is never written.
 *  3. The flush wait breaks early once liveness has dropped, instead of sitting out
 *     the full window where that reload can kill the finalize.
 *  4. Event routing is dropped AFTER the flush wait and BEFORE meetingEnded, or a
 *     late caption re-creates the session key the background just cleared.
 *  5. writer.close() after the final writeNow(), before meetingEnded.
 *  6. `ending` guards the presence handlers, so the end-of-call roster teardown does
 *     not emit a storm of "left" markers.
 *  7. The join-settle window is measured from THIS run's start, never from
 *     session.startedAt — a resumed session's start is far in the past.
 */
export async function runSession(deps: RunnerDeps): Promise<void> {
  const { adapter, roster, debug, tabId } = deps
  const meetingKey = adapter.meetingKey()
  if (!meetingKey) return
  debug.log("waiting to join", { path: meetingKey })

  // The tab key holds at most one session. If it belongs to a DIFFERENT meeting,
  // that meeting's content script was torn down before it could finalize (left via
  // the platform's UI, then opened another call in this tab) — its transcript is
  // still intact under the key, but our first write below would overwrite and lose
  // it. Finalize it FIRST: the background commits the stored session to history +
  // disk and clears the key. Done before the join wait, so it is saved even if the
  // user backs out of this lobby — and before meetingStarted, so finalize's
  // untrackTab can't drop the tab we are about to re-track. A same-key session is a
  // genuine reload-resume of this meeting (handled below), not stale.
  const previous = await getLocal<ActiveSession>(sessionKey(tabId))
  if (shouldFinalizeStaleSession(previous?.path ?? null, meetingKey)) {
    debug.log("finalizing a previous meeting's session before it is overwritten", {
      stalePath: previous!.path,
      path: meetingKey,
    })
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) {
      console.error("[platica-notes] stale-session finalize failed:", response.error)
      debug.log("stale-session finalize failed", { error: response.error })
      deps.noteIfInvalidated(response)
    }
  }

  // Abort the lobby wait if the user backs out without joining.
  const joined = await adapter.waitForJoin(() => adapter.meetingKey() !== meetingKey)
  if (!joined) return
  debug.log("meeting started", { tab: tabId })
  deps.noteIfInvalidated(await sendToBackground({ kind: "meetingStarted" }))

  const settings = await getSettings()
  let ending = false
  // Is the platform's media path down as of the latest liveness event? Only meaningful
  // when the adapter declares livenessEnd; it short-circuits the flush wait, because
  // once the path is down no further captions can arrive.
  let livenessDown = false

  // Capture health. Seeded from whatever the platform already knows: the capture
  // channel can come up before this session exists, and a session that missed the
  // signal would otherwise sit in "opening" and cry wolf.
  const seen = adapter.initialHealth?.()
  let health: Health = {
    code: seen === undefined || seen === null ? "opening" : seen === "channel-open" ? "armed" : seen,
    since: new Date().toISOString(),
  }
  let healthNotice: { dismiss: () => void } | null = null
  const applyHealth = (input: HealthInput): void => {
    const before = health.code
    health = nextHealth(health, input)
    if (health.code === before) return
    debug.log("capture health", { code: health.code, detail: health.detail })
    if (isAlarming(health.code)) {
      // One notice at a time; a new alarming code replaces the previous message.
      healthNotice?.dismiss()
      healthNotice = showPersistentNotice(healthMessage(health.code))
    } else {
      healthNotice?.dismiss()
      healthNotice = null
    }
  }

  // This meeting's debug window starts here. Earlier events (e.g. the MAIN-world
  // "installed") fall into the first meeting — acceptable.
  const debugStart = debug.events().length

  // A mid-meeting reload of the SAME meeting continues its session (read above),
  // rather than erasing it. A different-meeting session was already finalized and
  // its key cleared just above, so it never resumes here.
  const resumed = previous && previous.path === meetingKey ? previous : null
  if (resumed) debug.log("resuming session after reload")
  // A full page reload resets the page-level roster/selfName, and a platform
  // typically streams the roster and the self identity only at the initial join —
  // not after a reload — so neither is re-delivered to the resumed session. Re-seed
  // both from the snapshot, otherwise every speaker falls back to "Speaker N".
  if (resumed) {
    for (const [id, name] of Object.entries(resumed.roster ?? {})) roster.set(id, name)
    if (!deps.getSelfName() && resumed.selfName) deps.setSelfName(resumed.selfName)
  }
  const prefixTranscript = resumed ? resumed.transcript : []
  const prefixChat = resumed ? resumed.chat : []
  // Debug from a resumed snapshot is prepended, mirroring transcript/chat.
  const prefixDebug = resumed?.debug ?? []
  // Attendees from a resumed snapshot seed the set (?? [] tolerates pre-feature snapshots).
  const prefixParticipants = resumed?.participants ?? []
  const prefixRawVersions = resumed?.rawVersions ?? []
  const prefixNotes = resumed?.notes ?? []
  const prefixParticipantEvents = resumed?.participantEvents ?? []

  const session: ActiveSession = {
    platform: adapter.id,
    path: meetingKey,
    title: resumed ? resumed.title : readTitle(),
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
  // language it was captured with. Re-push so a previous meeting's pill override
  // (which is never persisted) does not carry over.
  adapter.setLanguage?.(session.captionLanguage ?? settings.captionLanguage)

  // The page roster is shared in, so names resolve retroactively even for
  // participants whose roster entries arrived before this meeting's feed existed.
  const feed = new CaptureFeed(roster, adapter.captionRules)
  const writer = new SessionWriter<ActiveSession>(
    (snapshot) => setLocal({ [sessionKey(tabId)]: snapshot }),
    // Stamp the current page-level roster and self name into every persisted
    // snapshot so a reload can re-seed them (see the resume block above), plus any
    // platform-owned fields (Meet: the chat.google.com conversation URL).
    () => ({
      ...session,
      roster: Object.fromEntries(roster),
      selfName: deps.getSelfName() ?? undefined,
      ...adapter.snapshotFields?.(),
    }),
    1000,
    // A write that fails on an orphaned context surfaces the reload notice; the
    // writer seals itself so it stops hammering a dead chrome.storage.
    deps.onContextInvalidated,
  )
  writer.requestWrite()

  // Meeting-scoped attendee set. Fed by roster events and the self name. Deduped by
  // exact name, so a participant who reconnects with a new speaker id — or any
  // repeated roster broadcast — counts once.
  const attendees = new Set<string>()
  const recordAttendee = (name: string): void => {
    const trimmed = name.trim()
    if (!trimmed || attendees.has(trimmed)) return
    attendees.add(trimmed)
    session.participants = [...attendees]
    writer.requestWrite()
  }
  // Seed from the roster known at join time. Roster events stream from join time —
  // often before this wiring — so without seeding, participants who arrived before
  // the feed existed are missed from the list (they still resolve as speakers via
  // the page roster). Live arrivals after this are added above.
  for (const name of seedAttendees(prefixParticipants, [...roster.values()], deps.getSelfName())) {
    recordAttendee(name)
  }

  // Recorder's notes/bookmarks for this meeting, seeded from a resumed snapshot.
  const notes: Note[] = [...prefixNotes]

  // Join/leave markers, keyed by NAME not speakerId. Platforms churn speaker ids — a
  // reconnect gives the same person a NEW id while the old one tombstones — so an
  // id-keyed model emitted a false "joined" (new id) AND a false "left" (old id) for
  // one person merely reconnecting. Instead we track the set of active ids PER NAME:
  // a name JOINS when its set goes empty->non-empty (after the settle window), LEAVES
  // only when its set goes non-empty->empty (all their devices gone). A reconnect
  // keeps the set non-empty throughout, so it emits neither. The settle window is
  // measured from THIS run's start (invariant 7).
  const joinWatchStart = Date.now()
  const participantEvents: ParticipantEvent[] = [...prefixParticipantEvents]
  const activeByName = new Map<string, Set<string>>()
  // Seed with everyone already present at join (page roster is speakerId -> name).
  for (const [speakerId, name] of roster) {
    const set = activeByName.get(name) ?? new Set<string>()
    set.add(speakerId)
    activeByName.set(name, set)
  }

  // Always wire this up so an OFF->ON mid-meeting debug toggle starts flushing
  // immediately. The closure self-gates — no cost when debug is off for the whole
  // meeting (session.debug stays undefined), and ON->OFF freezes the trail because
  // the guard returns before writing.
  debug.onEvent(() => {
    if (!debug.enabled()) return
    const slice = debug.events().slice(debugStart)
    session.debug = [...prefixDebug, ...slice].slice(-DEBUG_EVENTS_MAX)
    writer.requestWrite()
  })

  // Set by the start-of-meeting language prompt below (null when not shown / once it
  // closes). Declared here so applyLanguage can close it on any language change.
  let languagePrompt: { unmount: () => void } | null = null
  // The ephemeral, this-meeting-only language switch shared by the pill and the
  // start-of-meeting prompt: resubscribe + snapshot into the session, never write
  // the persisted default (so the next meeting still starts from the default). Any
  // language change also closes the start prompt — once you have chosen (pill OR
  // prompt) the prompt has done its job, so it never lingers stale.
  const applyLanguage = (language: string): void => {
    session.captionLanguage = language
    writer.requestWrite()
    adapter.setLanguage?.(language)
    languagePrompt?.unmount()
    languagePrompt = null
  }

  const controls = mountMeetingControls({
    // A platform we cannot switch captions on gets no language pill at all, rather
    // than a control that silently does nothing.
    languageSwitch: adapter.capabilities.languageSwitch,
    initialLanguage: session.captionLanguage ?? settings.captionLanguage,
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
  if (
    adapter.capabilities.languageSwitch !== "none" &&
    shouldAskLanguage(settings.askLanguageEachMeeting, !!resumed, isUiHidden())
  ) {
    languagePrompt = mountLanguagePrompt({
      initialLanguage: session.captionLanguage ?? settings.captionLanguage,
      onPick: (language) => {
        applyLanguage(language)
        controls.setLanguage(language)
      },
      onDisableAsking: () => void saveSettings({ askLanguageEachMeeting: false }),
    })
  }

  // Re-resolve speaker names (they resolve from the roster at snapshot time) and push
  // the fresh transcript to the panel, so a name learned mid-meeting appears without
  // waiting for the next caption.
  const refreshTranscript = (): void => {
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
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

  // A roster entry appeared. Add it to its name's active set; a name whose set was
  // EMPTY and goes non-empty after the settle window (and is not self) is a genuine
  // join. A reconnect (new id while an old one is still active) keeps the set
  // non-empty -> no marker.
  const recordDevice = (speakerId: string, name: string): void => {
    if (ending) return
    const set = activeByName.get(name) ?? new Set<string>()
    const wasActive = set.size > 0
    set.add(speakerId)
    activeByName.set(name, set)
    // isMidMeetingJoin's `alreadyKnown` is "this name already had an active device".
    const isJoin = isMidMeetingJoin(
      name,
      deps.getSelfName(),
      wasActive,
      Date.now() - joinWatchStart,
      adapter.timings.joinSettleMs,
    )
    debug.log("device seen", { deviceId: speakerId, name, wasActive, isJoin })
    if (isJoin) pushPresence(name, "join")
  }

  // A roster entry was removed (tombstone). Drop it from its name's active set; a
  // name whose set goes EMPTY (all devices gone, not self) is a genuine leave. A
  // reconnect's stale tombstone leaves the set non-empty -> no marker. The `ending`
  // guard suppresses the end-of-meeting teardown cascade (a platform drops every
  // device at once when the call ends). Timing note: the tombstone can lag.
  const recordLeave = (speakerId: string, carriedName?: string): void => {
    if (ending) return
    const name = carriedName || roster.get(speakerId)
    const set = name ? activeByName.get(name) : undefined
    if (!name || !set || !set.has(speakerId)) return
    set.delete(speakerId)
    debug.log("device left", { deviceId: speakerId, name, remaining: set.size })
    if (set.size > 0) return
    if (deps.getSelfName() && name === deps.getSelfName()) return
    pushPresence(name, "leave")
  }

  // Append a timestamped note (empty text = a bare bookmark) to this meeting.
  // Reached from the panel's note input and the page-level bookmark chord.
  function addNote(text: string): void {
    if (!recording) {
      showToast("Recording is off")
      return
    }
    notes.push({ at: new Date().toISOString(), text: text.trim() })
    session.notes = [...notes]
    panel.update(session.transcript, session.chat, session.notes, session.participantEvents ?? [])
    writer.requestWrite()
    pulseActivity()
  }
  deps.bindNoteSink(addNote)

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

  // The platform can fill the real meeting name in with a delay. Cleared on finalize
  // so a short meeting leaves no stray timer firing after teardown.
  const titleTimer = setTimeout(() => {
    if (ending) return
    session.title = readTitle()
    writer.requestWrite()
  }, TITLE_RETRY_MS)

  let firstCaptionLogged = false
  const unsubscribe = adapter.subscribe((event: CaptureEvent) => {
    switch (event.type) {
      case "roster":
        recordAttendee(event.name)
        recordDevice(event.speakerId, event.name)
        refreshTranscript()
        return
      case "roster-leave":
        recordLeave(event.speakerId, event.name)
        return
      case "self":
        recordAttendee(event.name)
        return
      case "liveness":
        livenessDown = event.openSessions === 0
        return
      case "health":
        applyHealth(
          event.code === "channel-open"
            ? { kind: "channel-open", now: new Date().toISOString() }
            : { kind: "reported", code: event.code, detail: event.detail, now: new Date().toISOString() },
        )
        return
      case "utterance": {
        // Text on the wire proves the path works, whether or not we are recording it.
        applyHealth({ kind: "utterance", now: new Date().toISOString() })
        if (!recording) return
        if (!feed.handleCaption(event, new Date().toISOString())) return
        if (!firstCaptionLogged) {
          firstCaptionLogged = true
          debug.log("captions are flowing")
        }
        session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
        session.rawVersions = [...prefixRawVersions, ...feed.versionsSnapshot()]
        panel.update(session.transcript, session.chat, session.notes ?? [], session.participantEvents ?? [])
        writer.requestWrite()
        pulseActivity()
        return
      }
      case "chat": {
        // A platform that declares it cannot capture chat must not slip chat into a
        // file anyway (a partial path would produce own-messages-only transcripts).
        if (!adapter.capabilities.chat) return
        if (!recording) return
        if (!feed.handleChat(event, new Date().toISOString())) return
        session.chat = [...prefixChat, ...feed.chatSnapshot()]
        // Chat shares the live timeline, so reflect it in the panel (and pulse)
        // exactly like a caption.
        panel.update(session.transcript, session.chat, session.notes ?? [], session.participantEvents ?? [])
        writer.requestWrite()
        pulseActivity()
        return
      }
    }
  })

  // --- meeting end detection ---------------------------------------------------
  // Owned by the platform (adapter.watchEnd); it calls back with a reason and hands
  // us a teardown.
  let meetingDone!: () => void
  const done = new Promise<void>((resolve) => {
    meetingDone = resolve
  })
  const stopWatchingEnd = adapter.watchEnd((reason) => void endMeeting(reason))
  // -----------------------------------------------------------------------------

  // Clock input for the health fold: promotes the initial wait to an alarm if the
  // capture channel never comes up. Silence in an armed channel never trips it.
  const healthTicker = setInterval(() => applyHealth({ kind: "tick", now: new Date().toISOString() }), HEALTH_TICK_MS)

  // The language prompt already says "recording in X" — skip the generic toast when
  // it is up, so the two do not stack on the same spot.
  if (!languagePrompt) showToast("Plática Notes is recording this meeting")
  await done
  return

  // ---------- closures ----------

  function readTitle(): string {
    return adapter.readTitle() || document.title
  }

  async function endMeeting(reason: string): Promise<void> {
    if (ending) return
    ending = true
    debug.log("meeting ended", { reason })
    // Stop the end-detection machinery first so neither the poller nor a residual
    // leave click can re-enter during the flush wait below.
    stopWatchingEnd()
    clearTimeout(titleTimer)
    clearInterval(healthTicker)
    // Leave the event subscription attached and wait: a platform can keep streaming
    // the final caption revision for a couple of seconds after the call ends (same
    // utterance id, higher revision), so the feed completes the closing sentence
    // before we snapshot. The `ending` guard above makes a concurrent endMeeting call
    // a no-op during this window.
    debug.log("finalizing after caption flush", { reason })
    // Persist the current transcript BEFORE the flush wait (invariant 2). The page
    // can reload right after the call ends, tearing down this content script mid-wait
    // before the finalize below runs (observed: the first Leave produced no file, the
    // session resumed on the reload and only saved on the next Leave). Writing now
    // means the stored session is complete-so-far regardless.
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    session.chat = [...prefixChat, ...feed.chatSnapshot()]
    session.participantEvents = [...participantEvents]
    writer.requestWrite()
    // Wait for trailing caption revisions, but ONLY while the media path is still up
    // (invariant 3). Once it drops no further captions can arrive, so there is
    // nothing to flush — finalize at once rather than sitting in the wait window
    // where a reload can kill the finalize before it saves the file.
    const flushStart = Date.now()
    while (Date.now() - flushStart < adapter.timings.captionFlushMs) {
      if (livenessDown) break
      await delay(FLUSH_POLL_MS)
    }
    // Now stop routing (invariant 4): an event arriving after finalization would
    // re-create the session key the background just cleaned up. Clear the debug hook
    // here too so a late debug event cannot resurrect the session.
    unsubscribe()
    debug.onEvent(null)
    deps.bindNoteSink(null)
    controls.unmount()
    panel.unmount()
    languagePrompt?.unmount()
    healthNotice?.dismiss()
    // Final snapshot resolves speaker names from the roster as it stands now, and
    // includes anything the flush wait above let land.
    session.transcript = [...prefixTranscript, ...feed.transcriptSnapshot()]
    session.rawVersions = [...prefixRawVersions, ...feed.versionsSnapshot()]
    session.chat = [...prefixChat, ...feed.chatSnapshot()]
    session.participants = [...attendees]
    session.notes = [...notes]
    session.participantEvents = [...participantEvents]
    // Record WHY nothing (or little) was captured, but only when the answer is not
    // "it worked": an empty transcript otherwise reads as our bug rather than as
    // captions never having started.
    if (health.code !== "capturing") session.captureHealth = health.code
    // Capture the complete debug trail (including this "meeting ended") into the
    // final snapshot. Stays undefined when disabled — no behavioural change.
    if (debug.enabled()) session.debug = [...prefixDebug, ...debug.events().slice(debugStart)]
    await writer.writeNow()
    // Seal the writer (invariant 5): any late event/timer must not re-create the
    // session key the background is about to clean up in meetingEnded.
    writer.close()
    const response = await sendToBackground({ kind: "meetingEnded" })
    if (!response.ok) {
      console.error("[platica-notes] finalize failed:", response.error)
      debug.log("finalize failed", { error: response.error })
      deps.noteIfInvalidated(response)
    }
    meetingDone()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
