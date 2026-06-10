import type { Meeting } from "../shared/types"

const PLATFORM_LABELS: Record<Meeting["platform"], string> = {
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", TIME_FORMAT)
}

export function formatMeetingText(meeting: Meeting): string {
  const lines: string[] = [
    meeting.title,
    `Platform: ${PLATFORM_LABELS[meeting.platform]}`,
    `Started: ${formatTimestamp(meeting.startedAt)}`,
    `Ended: ${formatTimestamp(meeting.endedAt)}`,
    "",
    "TRANSCRIPT",
    "----------",
    "",
  ]
  for (const utterance of meeting.transcript) {
    lines.push(`${utterance.speaker} (${formatTimestamp(utterance.startedAt)}):`)
    lines.push(utterance.text)
    lines.push("")
  }
  if (meeting.chat.length > 0) {
    lines.push("CHAT")
    lines.push("----")
    lines.push("")
    for (const message of meeting.chat) {
      lines.push(`${message.sender} (${formatTimestamp(message.sentAt)}):`)
      lines.push(message.text)
      lines.push("")
    }
  }
  return lines.join("\n")
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
  return cleaned || "Meeting"
}

export function meetingFileName(meeting: Meeting): string {
  const stamp = meeting.startedAt.slice(0, 16).replace("T", " ").replace(":", "-")
  return `${sanitizeFileName(meeting.title)} ${stamp}.txt`
}
