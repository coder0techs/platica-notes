import type { Meeting } from "../shared/types"
import { getLocal, setLocal } from "../shared/storage"
import { mergeMeetings, shouldMerge } from "./merge"

export function appendWithRetention(meetings: Meeting[], meeting: Meeting, limit: number): Meeting[] {
  const next = [...meetings, meeting]
  return next.length > limit ? next.slice(next.length - limit) : next
}

let queue: Promise<unknown> = Promise.resolve()

export function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = queue.then(operation, operation)
  queue = run.then(() => undefined, () => undefined)
  return run
}

export async function listMeetings(): Promise<Meeting[]> {
  return (await getLocal<Meeting[]>("meetings")) ?? []
}

export async function getMeeting(id: string): Promise<Meeting | undefined> {
  return (await listMeetings()).find(meeting => meeting.id === id)
}

export function addMeeting(meeting: Meeting, limit: number): Promise<void> {
  return enqueue(async () => {
    const meetings = await listMeetings()
    await setLocal({ meetings: appendWithRetention(meetings, meeting, limit) })
  })
}

// Atomically commit a finalized meeting: either fold it into the most recent
// mergeable same-code visit (when merging is on) or append it with retention.
// The read-decide-write runs inside one enqueue critical section so two tabs
// finalizing at once cannot race a read-then-write. Returns the stored meeting
// (the merge target's identity when merged, else the incoming one).
export function commitFinalizedMeeting(
  incoming: Meeting,
  opts: { mergeEnabled: boolean; gapMs: number },
  limit: number,
): Promise<{ meeting: Meeting; merged: boolean }> {
  return enqueue(async () => {
    const meetings = await listMeetings()
    if (opts.mergeEnabled) {
      // Scan newest-first; the first mergeable candidate is the most recent
      // same-code visit within the gap (older ones only have a larger gap).
      for (let i = meetings.length - 1; i >= 0; i--) {
        if (shouldMerge(meetings[i], incoming, opts.gapMs)) {
          const merged = mergeMeetings(meetings[i], incoming)
          const next = meetings.slice()
          next[i] = merged
          await setLocal({ meetings: next })
          return { meeting: merged, merged: true }
        }
      }
    }
    await setLocal({ meetings: appendWithRetention(meetings, incoming, limit) })
    return { meeting: incoming, merged: false }
  })
}

export function deleteMeeting(id: string): Promise<void> {
  return enqueue(async () => {
    const meetings = await listMeetings()
    await setLocal({ meetings: meetings.filter(m => m.id !== id) })
  })
}

// "Pending export" tracks meetings that were committed to the history store but
// whose .md file has not been confirmed written. finalizeSession marks a meeting
// pending before it hands the result to the downloader; the downloader clears it
// only after chrome.downloads succeeds. On every service-worker start the
// background re-exports anything still pending — so an SW eviction between commit
// and download can no longer silently skip the auto-export. (The transcript was
// never at risk; it lives in the history store and is re-downloadable by hand.)
const PENDING_EXPORTS_KEY = "pendingExports"

export async function listPendingExports(): Promise<string[]> {
  return (await getLocal<string[]>(PENDING_EXPORTS_KEY)) ?? []
}

export function addPendingExport(id: string): Promise<void> {
  return enqueue(async () => {
    const ids = (await getLocal<string[]>(PENDING_EXPORTS_KEY)) ?? []
    if (!ids.includes(id)) await setLocal({ [PENDING_EXPORTS_KEY]: [...ids, id] })
  })
}

export function clearPendingExport(id: string): Promise<void> {
  return enqueue(async () => {
    const ids = (await getLocal<string[]>(PENDING_EXPORTS_KEY)) ?? []
    await setLocal({ [PENDING_EXPORTS_KEY]: ids.filter(x => x !== id) })
  })
}
