// Platform-neutral pure decisions used by the session runner. No DOM, no chrome.*,
// no timers — every input is passed in, so the whole file is unit-testable. Meet's
// own decisions (the leave-icon poller, the media-path end signal, the caption-tail
// grace) live in platforms/meet-lifecycle.ts.

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

// Whether a roster device appearance is a mid-meeting JOIN worth marking inline.
// Join arrives as an ordinary device event (deviceId -> name) that also streams
// the initial roster and any post-reload re-sync, so we suppress the noise:
//   - alreadyKnown: this deviceId was already accounted for this meeting (seeded
//     from the roster at join, or seen earlier) — not a new arrival.
//   - within the settle window (measured from THIS run's start, not the session's
//     startedAt — a reload replays the whole roster): the initial roster / reload
//     re-sync, whose members are already in the front-matter list.
//   - self: the local user is never marked as "joining" their own recording.
// The caller owns the known-device set (adds every seen deviceId regardless).
export function isMidMeetingJoin(
  name: string,
  selfName: string | null,
  alreadyKnown: boolean,
  elapsedSinceJoinMs: number,
  settleMs: number,
): boolean {
  if (alreadyKnown) return false
  if (elapsedSinceJoinMs < settleMs) return false
  if (selfName && name === selfName) return false
  return true
}

// Whether to show the start-of-meeting language prompt: only when the user opted
// in, on a FRESH meeting (a reload-resume already has its language), and not while
// all extension UI is hidden (a deliberate clean view for screen-share/demo).
export function shouldAskLanguage(ask: boolean, isResumed: boolean, uiHidden: boolean): boolean {
  return ask && !isResumed && !uiHidden
}
