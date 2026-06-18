import type { Meeting } from "../shared/types"
import { getLocal, setLocal } from "../shared/storage"

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

export function updateMeeting(id: string, patch: Partial<Meeting>): Promise<void> {
  return enqueue(async () => {
    const meetings = await listMeetings()
    await setLocal({ meetings: meetings.map(m => (m.id === id ? { ...m, ...patch } : m)) })
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
