import type { ActiveSession, DebugEvent, Meeting } from "../shared/types"
import { mergeMeetings, shouldMerge } from "./merge"

/** Join link of the meeting a session is recording, when it has one. */
export function meetingUrlOf(session: Pick<ActiveSession, "platform" | "path">): string | undefined {
  return session.platform === "meet" && session.path ? `https://meet.google.com${session.path}` : undefined
}

/**
 * The Meeting a live session stands for at instant `endedAt`.
 *
 * Finalization and the mid-meeting snapshot both build their Meeting here, and
 * that is the point: a file whose shape changed the moment the meeting ended
 * would be a file no reader could rely on, and two copies of this object literal
 * would drift apart the first time a field was added to one of them.
 */
export function sessionToMeeting(
  session: ActiveSession,
  opts: { id: string; endedAt: string; fallbackLanguage: string },
): Meeting {
  return {
    id: opts.id,
    platform: session.platform,
    title: session.title,
    startedAt: session.startedAt,
    endedAt: opts.endedAt,
    isPrivate: session.isPrivate,
    transcript: session.transcript,
    chat: session.chat,
    participants: session.participants ?? [],
    rawVersions: session.rawVersions ?? [],
    notes: session.notes ?? [],
    participantEvents: session.participantEvents ?? [],
    recorder: session.selfName,
    lite: session.lite ?? [],
    language: session.captionLanguage ?? opts.fallbackLanguage,
    meetingUrl: meetingUrlOf(session),
    chatUrl: session.chatUrl,
  }
}

/**
 * Which Meeting a mid-meeting snapshot should render, given what history already
 * holds.
 *
 * This mirrors the merge decision `commitFinalizedMeeting` makes at the end of a
 * meeting, deliberately: a snapshot taken during a rejoin has to land in the file
 * the finished meeting will land in, or the rejoin leaves behind a partial file
 * under its own name that nothing ever completes. Folding the prior visit in also
 * means the snapshot is a superset of what is already on disk, never less.
 */
export function resolveSnapshot(
  partial: Meeting,
  meetings: Meeting[],
  opts: { mergeEnabled: boolean; gapMs: number },
): Meeting {
  if (!opts.mergeEnabled) return partial
  // Newest-first: the first mergeable candidate is the most recent same-code
  // visit within the gap, exactly as the finalize-time scan picks it.
  for (let i = meetings.length - 1; i >= 0; i--) {
    if (shouldMerge(meetings[i], partial, opts.gapMs)) return mergeMeetings(meetings[i], partial)
  }
  return partial
}

/**
 * The debug trail as a snapshot should write it: the events so far, closed with a
 * marker saying this dump is mid-meeting.
 *
 * JSONL has no header, so the "still running" disclaimer the .md carries in its
 * front matter has to be a record. A reader tells a partial dump from a finished
 * one by whether the last line says `snapshot` or `finalized`. The input array is
 * never mutated: it stays in the live session, and a marker appended to it would
 * accumulate one line per press.
 */
export function snapshotDebugEvents(session: ActiveSession, at: string): DebugEvent[] {
  const events = session.debug ?? []
  if (events.length === 0) return []
  return [
    ...events,
    {
      t: at,
      ctx: "bg",
      msg: "snapshot",
      utterances: session.transcript.length,
      chat: session.chat.length,
      isPrivate: session.isPrivate,
    },
  ]
}
