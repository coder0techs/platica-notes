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
