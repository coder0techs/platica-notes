import type { DebugEvent, Meeting } from "../shared/types"

// Injected by esbuild's define at build time; typeof-guarded so vitest (which
// does not define them) falls back to "dev" instead of throwing ReferenceError.
const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
const COMMIT = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"

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

// Strips pure left-to-right typing from a caption's version history, keeping only
// the revision points. A frame is dropped ONLY when it is a verbatim prefix of the
// next frame (the next frame just appended to it) — so every character of a dropped
// frame is reproduced later, making this provably lossless for reconstruction. Any
// frame where text was shortened, rewritten mid-string, recased, or repunctuated is
// NOT a prefix of its successor and is kept. The final frame is always kept.
export function collapseVersions(versions: string[]): string[] {
  return versions.filter((v, i) => i === versions.length - 1 || !versions[i + 1].startsWith(v))
}

export function formatMeetingText(meeting: Meeting): string {
  const lines: string[] = [
    meeting.title,
    `Platform: ${PLATFORM_LABELS[meeting.platform]}`,
    `Started: ${formatTimestamp(meeting.startedAt)}`,
    `Ended: ${formatTimestamp(meeting.endedAt)}`,
  ]
  // Attendance list. Optional via ?. so meetings stored before this field existed
  // still render. Sorted here so output is deterministic regardless of capture order.
  if (meeting.participants?.length) {
    lines.push("", "PARTICIPANTS", "------------")
    for (const name of [...meeting.participants].sort((a, b) => a.localeCompare(b))) {
      lines.push(name)
    }
  }
  lines.push("", "TRANSCRIPT", "----------", "")
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
  // Machine-readable revision history for transcript-reconstruction agents.
  // Collapse pure left-to-right typing (see collapseVersions) so only revision
  // points survive, then emit only phrases that still have more than one frame
  // (a phrase that just grew, or never changed, adds nothing over the transcript
  // line above). Optional via ?. so meetings stored before this field existed
  // still render.
  const revised = (meeting.rawVersions ?? [])
    .map((v) => ({ ...v, versions: collapseVersions(v.versions) }))
    .filter((v) => v.versions.length > 1)
  if (revised.length > 0) {
    lines.push("RAW CAPTION VERSIONS")
    lines.push("--------------------")
    lines.push("")
    lines.push(
      "Machine-generated revision points of each caption: the form before each time " +
        "Google shortened or rewrote already-typed text, plus the final version. Pure " +
        "left-to-right typing between these points is collapsed (losslessly: a dropped " +
        "frame is always a prefix of the next). For transcript-reconstruction agents, " +
        "not human reading. The last line of each block is the text that appears in " +
        "TRANSCRIPT above; earlier lines may contain words the final version dropped. " +
        "Phrases that only grew, or never changed, are omitted.",
    )
    lines.push("")
    for (const entry of revised) {
      lines.push(`${entry.speaker} (${formatTimestamp(entry.startedAt)}):`)
      for (const [i, text] of entry.versions.entries()) lines.push(`${i + 1}. ${text}`)
      lines.push("")
    }
  }
  lines.push("")
  lines.push(`— Plática Notes ${VERSION} (${COMMIT})`)
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
  return `${fileBase(meeting)}.md`
}

export function debugLogFileName(meta: { title: string; startedAt: string }): string {
  return `${fileBase(meta)}.debug.jsonl`
}

export function formatDebugLog(events: DebugEvent[]): string {
  if (events.length === 0) return ""
  return events.map(e => JSON.stringify(e)).join("\n")
}
