import { meetCodeFromPath } from "../shared/meet-url"
import { isCaptureFailure, type Meeting } from "../shared/types"

// Two visits of the same Meet code merge only when the second starts within this
// window of the first's end. ~40 min targets the actual case — an accidental
// leave/rejoin of an ongoing call — while staying short enough that a persistent
// meeting "room" reused for a different, later call is not wrongly merged (this
// matters more now that merging is on by default). A daily recurring meeting
// (~22 h apart) is nowhere near it. Gap-only (no calendar-day rule) is correct
// across midnight.
export const MERGE_GAP_MS = 40 * 60 * 1000

// The Meet code (abc-defg-hij) carried in a meeting's join url, wherever Meet puts
// it in the path (see meet-url.ts). null when absent, not that shape (e.g. a
// /lookup link) or on another host, which disables merging for it.
export function meetCodeFromUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.hostname === "meet.google.com" ? meetCodeFromPath(u.pathname) : null
  } catch {
    return null
  }
}

// True when `incoming` is a sequential rejoin of the same meeting as `target`:
// same Meet code, same privacy (never fold private into public or vice versa),
// and starting after target ended but within gapMs. A negative gap means the
// visits overlapped (two simultaneous tabs) — not merged, which avoids tail dedup.
export function shouldMerge(target: Meeting, incoming: Meeting, gapMs: number): boolean {
  if (target.platform !== "meet" || incoming.platform !== "meet") return false
  // A visit that captured nothing is kept as a failure row; folding a rejoin into
  // it would hide the failure that row exists to show.
  if (isCaptureFailure(target)) return false
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
    participantEvents: [...(target.participantEvents ?? []), ...(incoming.participantEvents ?? [])],
    participants: [...new Set([...target.participants, ...incoming.participants])],
    ...(target.lite || incoming.lite ? { lite: [...(target.lite ?? []), ...(incoming.lite ?? [])] } : {}),
    ...(target.language ?? incoming.language ? { language: target.language ?? incoming.language } : {}),
    visits: [...targetVisits, { startedAt: incoming.startedAt, endedAt: incoming.endedAt }],
  }
}
