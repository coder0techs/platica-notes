import type { Meeting } from "../shared/types"

// Two visits of the same Meet code merge only when the second starts within this
// window of the first's end. 2 h comfortably covers "I dropped, stepped away, and
// rejoined the ongoing call" while a daily recurring meeting (~22 h apart) is
// nowhere near it. Gap-only (no calendar-day rule) is correct across midnight.
export const MERGE_GAP_MS = 2 * 60 * 60 * 1000

// The Meet code (abc-defg-hij) carried in a meeting's join url. null when absent
// or not that shape (e.g. a /lookup link), which disables merging for it.
export function meetCodeFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i)
  return m ? m[1].toLowerCase() : null
}

// True when `incoming` is a sequential rejoin of the same meeting as `target`:
// same Meet code, same privacy (never fold private into public or vice versa),
// and starting after target ended but within gapMs. A negative gap means the
// visits overlapped (two simultaneous tabs) — not merged, which avoids tail dedup.
export function shouldMerge(target: Meeting, incoming: Meeting, gapMs: number): boolean {
  if (target.platform !== "meet" || incoming.platform !== "meet") return false
  if (target.isPrivate !== incoming.isPrivate) return false
  const code = meetCodeFromUrl(target.meetingUrl)
  const incomingCode = meetCodeFromUrl(incoming.meetingUrl)
  if (code === null || incomingCode === null || code !== incomingCode) return false
  const gap = Date.parse(incoming.startedAt) - Date.parse(target.endedAt)
  return gap >= 0 && gap <= gapMs
}

// Fold `incoming` into `target`, returning a new Meeting. Identity/title/filename
// inputs come from target (so the file overwrites in place); endedAt advances to
// incoming's; body arrays concatenate (flattenTimeline re-sorts by time on
// render); participants union; visit spans accumulate. The first merge synthesizes
// target's own span so `visits` always describes every visit.
export function mergeMeetings(target: Meeting, incoming: Meeting): Meeting {
  const targetVisits = target.visits ?? [{ startedAt: target.startedAt, endedAt: target.endedAt }]
  return {
    ...target,
    endedAt: incoming.endedAt,
    transcript: [...target.transcript, ...incoming.transcript],
    chat: [...target.chat, ...incoming.chat],
    rawVersions: [...(target.rawVersions ?? []), ...(incoming.rawVersions ?? [])],
    notes: [...(target.notes ?? []), ...(incoming.notes ?? [])],
    participants: [...new Set([...target.participants, ...incoming.participants])],
    visits: [...targetVisits, { startedAt: incoming.startedAt, endedAt: incoming.endedAt }],
  }
}
