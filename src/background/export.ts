import type { Meeting } from "../shared/types"
import { formatMeetingText, meetingFileName } from "./format"

export async function downloadMeeting(meeting: Meeting): Promise<void> {
  const content = formatMeetingText(meeting)
  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(content)
  await chrome.downloads.download({
    url,
    filename: `Platica Notes/${meetingFileName(meeting)}`,
    conflictAction: "uniquify",
  })
}
