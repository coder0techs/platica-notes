import type { Meeting } from "../shared/types"
import { formatMeetingText, meetingFileName } from "./format"

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
