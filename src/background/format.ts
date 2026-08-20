import type { DebugEvent, Meeting } from "../shared/types"
import { flattenTimeline } from "../shared/transcript"
import { meetCodeFromUrl } from "./merge"

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

// Elapsed time from `fromIso` to `toIso`, always HH:MM:SS. Negative/zero clamps to
// zero. Timezone-independent (a difference).
//
// Fixed width is the point: this label used to be mm:ss and switch to h:mm:ss once
// a meeting passed an hour, so a parser written against a short meeting matched the
// first hour of a long one and silently dropped the rest (observed: 6 of 24 markers
// on a 61-minute call). One shape also makes the labels sort as strings. Hours grow
// past two digits rather than truncate, so an absurd span stays correct.
export function elapsedLabel(fromIso: string, toIso: string): string {
  const secs = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000))
  const h = Math.floor(secs / 3600)
  return `${pad2(h)}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`
}

// How long an entry lasted, as a unit-suffixed span: "30s", "3m05s". null for a
// zero/negative span so an instantaneous entry (chat, note, marker) renders
// nothing. The explicit units matter: a bare "03:05" sitting next to the elapsed
// offset on the same header line would read as a second wall-clock time.
export function durationLabel(fromIso: string, toIso: string): string | null {
  const secs = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000)
  if (!Number.isFinite(secs) || secs <= 0) return null
  const m = Math.floor(secs / 60)
  return m > 0 ? `${m}m${pad2(secs % 60)}s` : `${secs}s`
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
  if (meeting.chatUrl) fm.push(`chat_url: ${yamlScalar(meeting.chatUrl)}`)
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
  // Visit separators: for a merged meeting, each visit after the first has a
  // rejoin anchor. Before the first timeline entry at/after an anchor, emit a
  // heading (a `while` drains any anchors a single entry jumps past). Built only
  // from our own timestamps — no untrusted text, so injection-safety is intact.
  const visitAnchors = (meeting.visits ?? []).slice(1).map(v => v.startedAt)
  let visitPtr = 0
  for (const entry of flattenTimeline(meeting.transcript, meeting.chat, meeting.notes, meeting.participantEvents)) {
    while (visitPtr < visitAnchors.length && visitAnchors[visitPtr] <= entry.at) {
      const anchor = visitAnchors[visitPtr]
      lines.push(`## Visit ${visitPtr + 2} · rejoined ${isoLocal(anchor)} · +${elapsedLabel(meeting.startedAt, anchor)}`, "")
      visitPtr++
    }
    // A full local ISO instant per entry (not just the wall clock) so a consumer
    // never has to add the elapsed offset to the front matter's `started` to place
    // a turn in absolute time — the arithmetic that produced clock mismatches
    // downstream. The elapsed offset stays for the human reading the file.
    const span = durationLabel(entry.at, entry.endAt)
    const when =
      `${isoLocal(entry.at)}${span ? ` · ${span}` : ""} · +${elapsedLabel(meeting.startedAt, entry.at)}`
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
    // A participant join/leave is an annotation, not an utterance: render it as a
    // heading block with the name (inlineText'd so it can't forge a turn header)
    // and no body. Only "join" is emitted today; "leave" is handled for the future.
    if (entry.kind === "join" || entry.kind === "leave") {
      const verb = entry.kind === "join" ? "Joined" : "Left"
      lines.push(`### ${verb} · ${inlineText(entry.speaker)} · ${when}`, "")
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
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}`
}

// The YYYY-MM bucket a meeting is filed under. Derived from the START instant, so
// a call running over midnight into a new month stays with the day it began.
// Digits and one dash only — never user input, so it needs no sanitising.
export function monthFolder(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

// A filename segment with no spaces: the whole name is one shell-friendly token,
// so a glob or a script never has to quote it. Runs after sanitizeFileName, whose
// own "_" replacements collapse together with these.
function fileToken(name: string): string {
  return sanitizeFileName(name).replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "Meeting"
}

// `<date>_<time>_<title>[_<meet-code>]`. Date first so a folder listing sorts
// chronologically; the code last because its shape (3-4-3 lowercase) is a reliable
// right anchor, which keeps the whole name parseable by one regex even though the
// title may itself contain the "_" separator.
//
// Accepts the lighter { title, startedAt } meta so a full Meeting (which
// structurally satisfies it) and the finalize meta both work.
function fileBase(meta: { title: string; startedAt: string; meetingUrl?: string }): string {
  const title = fileToken(meta.title)
  const code = meetCodeFromUrl(meta.meetingUrl)
  // An unnamed meeting takes its title from document.title, which IS the code;
  // appending it again would stutter.
  const suffix = code && code !== title.toLowerCase() ? `_${code}` : ""
  return `${fileStamp(meta.startedAt)}_${title}${suffix}`
}

export function meetingFileName(meeting: Meeting): string {
  return `${fileBase(meeting)}.md`
}

export function debugLogFileName(meta: { title: string; startedAt: string; meetingUrl?: string }): string {
  return `${fileBase(meta)}.debug.jsonl`
}

export function formatDebugLog(events: DebugEvent[]): string {
  if (events.length === 0) return ""
  return events.map(e => JSON.stringify(e)).join("\n")
}
