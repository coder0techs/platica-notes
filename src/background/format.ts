import type { DebugEvent, Meeting } from "../shared/types"
import { flattenTimeline } from "../shared/transcript"

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

// Local wall-clock HH:MM for a turn header. The absolute instant lives in the
// front matter (started/ended), so a turn line only needs the clock + elapsed.
export function clockLabel(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const PLATFORM_SOURCES: Record<Meeting["platform"], string> = {
  meet: "google-meet-live-captions",
  zoom: "zoom-live-captions",
  teams: "teams-live-captions",
}

// Minimal YAML double-quoted scalar: safe for free-text values (title, names)
// that may contain ":" or quotes.
function yamlScalar(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`
}

// Body text occupies one physical line per turn. Collapse any newline so a value
// — notably a multi-line chat message (Meet allows Shift+Enter) — can never emit a
// second line that mimics a record header ([tN] …), an "  alt:" line, or a "---"
// fence in the v2 grid and get parsed as a forged, mis-attributed turn.
function inlineText(s: string): string {
  return s.replace(/\r\n?|\n/g, " ")
}

// feed.ts labels a device with no roster entry as `Speaker <tail>`. Surfacing it
// as a fact lets the pipeline distrust attribution there.
function isUnresolved(speaker: string): boolean {
  return /^Speaker /.test(speaker)
}

// Normalize a frame for COMPARISON ONLY: lowercase, then collapse every run of
// non-letter / non-number characters to a single space and trim. Google Meet flips
// the first letter's case ("за" vs "За") and churns punctuation between frames
// ("зашла." then "зашла в"), which would otherwise defeat the prefix check below and
// leak redundant frames as alt: noise. The \p{L}\p{N} unicode escapes need the `u`
// flag so Cyrillic (and other scripts) match.
const normFrame = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

// Strips noise from a caption's version history, keeping only the revision points.
// A frame is dropped ONLY when its NORMALIZED text (case- and punctuation-folded;
// see normFrame) is a prefix of the next frame's normalized text: the next frame
// just appended to it, or differs from it only in casing or punctuation. Every WORD
// of a dropped frame therefore survives in the kept next frame, so this stays
// word-lossless for reconstruction; only the casing/punctuation of intermediate
// frames is discarded. A frame whose text was shortened or rewritten mid-string is
// not a normalized prefix and is kept, so a genuine ASR self-correction survives as
// an alternative. The final frame is always kept, so the canonical text that appears
// in TRANSCRIPT is emitted verbatim (normalization never touches emitted frames).
export function collapseVersions(versions: string[]): string[] {
  return versions.filter((v, i) => {
    if (i === versions.length - 1) return true
    return !normFrame(versions[i + 1]).startsWith(normFrame(v))
  })
}

export interface FormatOptions {
  /** Emit caption alternatives (`> ↳ _alt:_ …`) under speech turns. Default off. */
  alternatives?: boolean
}

export function formatMeetingText(meeting: Meeting, opts: FormatOptions = {}): string {
  const fm: string[] = ["---", `title: ${yamlScalar(meeting.title)}`]
  if (meeting.meetingUrl) fm.push(`url: ${yamlScalar(meeting.meetingUrl)}`)
  if (meeting.language) fm.push(`language: ${yamlScalar(meeting.language)}`)
  fm.push(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  fm.push(`started: ${isoLocal(meeting.startedAt)}`)
  fm.push(`ended: ${isoLocal(meeting.endedAt)}`)
  if (meeting.recorder) fm.push(`recorder: ${yamlScalar(meeting.recorder)}`)
  if (meeting.participants?.length) {
    fm.push("participants:")
    for (const name of [...new Set(meeting.participants)].sort((a, b) => a.localeCompare(b))) {
      fm.push(`  - ${yamlScalar(name)}`)
    }
  }
  fm.push("---")
  // Machine/provenance triple lives in one comment, out of the human block. Still
  // greppable for any future re-import; schema is /3 (the body grammar changed).
  fm.push(`<!-- Plática Notes ${VERSION} (${COMMIT}) · schema platica-notes-transcript/3 · source ${PLATFORM_SOURCES[meeting.platform]} -->`)

  // Per-utterance caption alternatives, keyed by (speaker, startedAt, final text)
  // so a turn matches its own alts even when two same-speaker captions share a
  // millisecond. Built only when requested; otherwise the file stays clean.
  const altMap = new Map<string, string[]>()
  if (opts.alternatives) {
    for (const cv of meeting.rawVersions ?? []) {
      const collapsed = collapseVersions(cv.versions)
      if (collapsed.length > 1) {
        altMap.set(`${cv.speaker} ${cv.startedAt} ${collapsed[collapsed.length - 1]}`, collapsed.slice(0, -1))
      }
    }
  }

  const lines: string[] = [...fm, "", `# ${inlineText(meeting.title)}`, ""]
  for (const entry of flattenTimeline(meeting.transcript, meeting.chat, meeting.notes)) {
    const when = `${clockLabel(entry.at)} · +${elapsedLabel(meeting.startedAt, entry.at)}`
    // A recorder's note/bookmark is an annotation, not an utterance: render it as
    // a heading so it stands out structurally as its own block (not nested in a
    // speaker's quote) and never reads as a participant — for a human or an LLM.
    // The body stays in a blockquote so a note's text can never forge a turn. A
    // bare bookmark (empty text) is a marked moment with only the heading.
    if (entry.kind === "note") {
      if (entry.text.trim() === "") {
        lines.push(`### Bookmark · ${when}`, "")
      } else {
        lines.push(`### Note · ${when}`, `> ${inlineText(entry.text)}`, "")
      }
      continue
    }
    // inlineText the speaker too: in the prose format the name IS the structural
    // header (`**Name** · …`), so a newline in it could otherwise forge a turn.
    const tag = entry.kind === "chat" ? " · _chat_" : isUnresolved(entry.speaker) ? " · _unresolved_" : ""
    lines.push(`**${inlineText(entry.speaker)}**${tag} · ${when}`, `> ${inlineText(entry.text)}`)
    if (entry.kind === "speech") {
      const alts = altMap.get(`${entry.speaker} ${entry.at} ${entry.text}`)
      if (alts) for (const a of alts) lines.push(`> ↳ _alt:_ ${inlineText(a)}`)
    }
    lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

// Cap the per-segment length so a pathological multi-KB meeting title cannot
// produce a filename the OS rejects. 120 chars leaves room for the date stamp
// and extension well under the common ~255-byte filename limit.
const MAX_NAME_LEN = 120

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/_+/g, "_")
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
