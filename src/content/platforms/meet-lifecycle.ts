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
