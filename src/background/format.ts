import type { DebugEvent, Meeting } from "../shared/types"

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

// Produces a safe RELATIVE path for chrome.downloads: each "/"-segment is run
// through sanitizeFileName, and segments that are empty, "." or ".." are
// dropped. This guarantees no leading "/" (no absolute path), no ".." (no
// escaping Downloads), and no illegal filename chars per segment. Falls back
// when nothing survives.
export function sanitizeFolder(path: string, fallback: string): string {
  const segments = path
    .split("/")
    .filter(seg => {
      const trimmed = seg.trim()
      return trimmed !== "" && trimmed !== "." && trimmed !== ".."
    })
    .map(sanitizeFileName)
  return segments.length > 0 ? segments.join("/") : fallback
}

function fileStamp(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`
}

// Accepts the lighter { title, startedAt } meta so a full Meeting (which
// structurally satisfies it) and the finalize meta both work.
function fileBase(meta: { title: string; startedAt: string }): string {
  return `${sanitizeFileName(meta.title)} ${fileStamp(meta.startedAt)}`
}

export function meetingFileName(meeting: Meeting): string {
  return `${fileBase(meeting)}.txt`
}

export function debugLogFileName(meta: { title: string; startedAt: string }): string {
  return `${fileBase(meta)}.debug.jsonl`
}

export function formatDebugLog(events: DebugEvent[]): string {
  if (events.length === 0) return ""
  return events.map(e => JSON.stringify(e)).join("\n")
}
