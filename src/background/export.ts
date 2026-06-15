import type { DebugEvent, Meeting } from "../shared/types"
import { debugLogFileName, formatDebugLog, formatMeetingText, meetingFileName } from "./format"

export async function downloadMeeting(meeting: Meeting): Promise<void> {
  const content = formatMeetingText(meeting)
  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(content)
  // Private meetings land in a SIBLING folder ("Platica Notes private", not a
  // subfolder): folder-sync tools cannot exclude subfolders, and chrome.downloads
  // can only write inside the Downloads directory.
  const folder = meeting.isPrivate ? "Platica Notes private" : "Platica Notes"
  await chrome.downloads.download({
    url,
    filename: `${folder}/${meetingFileName(meeting)}`,
    conflictAction: "uniquify",
  })
}

export async function downloadDebugLog(
  meta: { title: string; startedAt: string },
  events: DebugEvent[],
): Promise<void> {
  if (events.length === 0) return // never write empty files
  const content = formatDebugLog(events)
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(content)
  // Always a single "Platica Logs" folder for both normal and private meetings,
  // never split by privacy: the debug log embeds the full transcript regardless
  // of the isPrivate flag, so the whole folder is local-only by convention and
  // meant to be kept out of cloud sync entirely.
  await chrome.downloads.download({
    url,
    filename: `Platica Logs/${debugLogFileName(meta)}`,
    conflictAction: "uniquify",
  })
}
