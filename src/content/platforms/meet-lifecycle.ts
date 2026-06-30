// Pure lifecycle decisions for the Meet adapter, split out of meet.ts so they can
// be unit-tested without meet.ts's import-time side effects (it calls main() and
// touches the DOM/chrome). These encode the two historically-fragile rules: the
// phantom-duplicate grace window and the leave-detection poller.

// Phantom-duplicate guard: after a meeting ends, Meet keeps streaming the final
// caption tail for a few seconds. Refuse to START a new session on the SAME code
// within the grace window so that tail drains with no active session to catch it.
// A genuine rejoin of the same code after the window still starts normally
// (the loop re-checks once the grace has elapsed).
export function shouldDrainTail(
  meetingPath: string,
  lastMeetingPath: string,
  lastEndedAt: number,
  now: number,
  graceMs: number,
): boolean {
  return meetingPath === lastMeetingPath && now - lastEndedAt < graceMs
}

// A tab's storage key (session-<tabId>) holds at most one active session. When a
// content script reloads straight into a DIFFERENT meeting — e.g. leaving via
// Meet's UI (Rejoin / home / a new call) then joining another code in the same
// tab, which tears the prior meeting's content script down before it can finalize
// — that prior session is still sitting under the tab key with its transcript
// intact. The new meeting's first write would overwrite it, silently losing it
// (it is never finalized, never reaches history or disk). So when the stored
// session is for a DIFFERENT path, finalize it FIRST. A same-path stored session
// is a genuine reload-resume of the very same meeting and must NOT be finalized.
export function shouldFinalizeStaleSession(previousPath: string | null, meetingPath: string): boolean {
  return previousPath !== null && previousPath !== meetingPath
}

// After a meeting ends, the loop waits for the residual leave icon to clear
// before re-arming, so a stale call_end icon on the post-leave screen does not
// instantly re-trigger a phantom join. But a fast rejoin puts the user back in
// the call before this wait begins, so the icon is present again and NEVER
// clears — an unbounded wait would block the loop forever and the rejoined
// session would never be recorded (the transcript-loss bug). Cap the wait at the
// tail-grace window: once it elapses, shouldDrainTail paces the restart instead.
export function shouldFinishRearmWait(iconGone: boolean, elapsedMs: number, capMs: number): boolean {
  return iconGone || elapsedMs >= capMs
}

// Build the attendee set known at a meeting's join time. Roster device events
// stream from join time — often BEFORE the meeting's recordAttendee is wired up —
// so early participants would otherwise land only in the page roster (where they
// still resolve as speakers) but never in the attendee list. Seeding the set from
// the roster captures them. Live arrivals after join are added incrementally.
// Order: resumed-snapshot prefix, then roster, then self; deduped by exact trimmed
// name (first occurrence wins), blanks dropped — matching recordAttendee.
export function seedAttendees(prefix: string[], rosterNames: string[], selfName: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of [...prefix, ...rosterNames, ...(selfName ? [selfName] : [])]) {
    const trimmed = name.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

// Authoritative end signal from the RTC layer. The MAIN-world script reports the
// number of open media-session data channels (one per peer connection); when it
// reaches zero the call's media path is down. A reconnect, however, can briefly
// zero the count before a new connection opens, so we don't end on the first zero
// — we track WHEN it first hit zero and only end once it has stayed there for a
// grace window. Two pure helpers keep the adapter glue trivial and this logic
// unit-tested: nextMediaZeroSince folds each media event into the "first zero"
// timestamp, shouldEndFromMedia decides on the endWatcher cadence.

// Carry the timestamp of the first zero-sessions observation. Null whenever the
// media path is live (openSessions > 0), so a session reopening cancels a pending
// end; the first zero stamps `now`, and further zeros keep that original stamp so
// the grace measures from when the path actually went down.
export function nextMediaZeroSince(prev: number | null, openSessions: number, now: number): number | null {
  if (openSessions > 0) return null
  return prev ?? now
}

// All media sessions have been closed for at least graceMs → the call's media
// path is authoritatively down. The grace absorbs a reconnect that momentarily
// zeroes the count before a new peer connection opens (verified against 50 real
// debug logs: genuine ends sit at zero and finalize in < 2 s; the only observed
// reconnect was make-before-break and never reached zero).
export function shouldEndFromMedia(zeroSince: number | null, now: number, graceMs: number): boolean {
  return zeroSince !== null && now - zeroSince >= graceMs
}

export interface LeaveState {
  end: boolean
  reason: string
  goneCount: number
}

// End-watcher step. A path change ends immediately ("left meeting page"). Otherwise
// the leave icon must be missing for `threshold` consecutive checks before we
// declare the call ended — the icon flickers during Meet's toolbar re-renders, so
// a single miss must not end the meeting.
export function nextLeaveState(
  pathChanged: boolean,
  iconPresent: boolean,
  goneCount: number,
  threshold: number,
): LeaveState {
  if (pathChanged) return { end: true, reason: "left meeting page", goneCount }
  const nextGone = iconPresent ? 0 : goneCount + 1
  if (nextGone >= threshold) return { end: true, reason: "call ended", goneCount: nextGone }
  return { end: false, reason: "", goneCount: nextGone }
}

// Whether to show the start-of-meeting language prompt: only when the user opted
// in, on a FRESH meeting (a reload-resume already has its language), and not while
// all extension UI is hidden (a deliberate clean view for screen-share/demo).
export function shouldAskLanguage(ask: boolean, isResumed: boolean, uiHidden: boolean): boolean {
  return ask && !isResumed && !uiHidden
}
