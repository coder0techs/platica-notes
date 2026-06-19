import type { DebugEvent, Meeting } from "../shared/types"
import { mergeTimeline } from "../shared/transcript"

// Injected by esbuild's define at build time; typeof-guarded so vitest (which
// does not define them) falls back to "dev" instead of throwing ReferenceError.
const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
const COMMIT = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"

const pad2 = (n: number) => String(n).padStart(2, "0")

// ISO 8601 in the runtime's local time with an explicit numeric offset and
// second precision (Date.toISOString only emits UTC "Z"). Lets the pipeline
// order turns and place them in absolute time without guessing the zone.
export function isoLocal(iso: string): string {
  const d = new Date(iso)
  const offMin = -d.getTimezoneOffset() // minutes east of UTC
  const sign = offMin >= 0 ? "+" : "-"
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

// Elapsed time from `fromIso` to `toIso` as mm:ss, rolling to h:mm:ss past an
// hour. Negative/zero clamps to 00:00. Timezone-independent (a difference).
export function elapsedLabel(fromIso: string, toIso: string): string {
  const secs = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

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

// Strips noise from a caption's version history, keeping only the revision points.
// A frame is dropped ONLY when, relative to the next frame, it is either (a) a
// verbatim prefix (the next frame just appended to it) or (b) the same text
// ignoring case (Meet flickers the first letter's case back and forth on the same
// words). In both cases every WORD of the dropped frame survives in the kept next
// frame, so this stays word-lossless for reconstruction — only the casing of
// intermediate frames is discarded. A frame where text was shortened, rewritten
// mid-string, or repunctuated is neither, and is kept. The final frame is always
// kept (so the canonical casing that appears in TRANSCRIPT survives).
export function collapseVersions(versions: string[]): string[] {
  return versions.filter((v, i) => {
    if (i === versions.length - 1) return true
    const next = versions[i + 1]
    return !next.startsWith(v) && next.toLowerCase() !== v.toLowerCase()
  })
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
  // Speech and chat share one chronological TRANSCRIPT, chat tagged "(chat)" — the
  // same interleaving the live panel shows. RAW CAPTION VERSIONS below stays
  // transcript-only.
  lines.push("", "TRANSCRIPT", "----------", "")
  for (const entry of mergeTimeline(meeting.transcript, meeting.chat)) {
    const label = entry.kind === "chat" ? `${entry.speaker} (chat)` : entry.speaker
    lines.push(`${label} (${formatTimestamp(entry.at)}):`)
    lines.push(entry.text)
    lines.push("")
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
        "left-to-right typing and pure case flicker between these points is collapsed " +
        "(word-losslessly: a dropped frame's words are always reproduced in the next). " +
        "For transcript-reconstruction agents, not human reading. The last line of each " +
        "block is the text that appears within the corresponding TRANSCRIPT block above; " +
        "earlier lines may contain words the final version dropped. " +
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

// Cap the per-segment length so a pathological multi-KB meeting title cannot
// produce a filename the OS rejects. 120 chars leaves room for the date stamp
// and extension well under the common ~255-byte filename limit.
const MAX_NAME_LEN = 120

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/[.\s]+$/, "") // re-trim: the slice may have ended on a dot/space
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
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}-${pad2(d.getMinutes())}`
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
