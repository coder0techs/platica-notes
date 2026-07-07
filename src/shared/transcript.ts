import type { ChatMessage, Note, Utterance } from "./types"

// One row of the unified meeting timeline: a speech turn, a chat message, or a
// recorder's note/bookmark.
export interface TimelineEntry {
  kind: "speech" | "chat" | "note"
  speaker: string
  text: string
  at: string // ISO 8601 — start of the entry
  // ISO 8601 — end of the entry (for speech, when its text last grew; for chat/note,
  // same as `at`). Lets the panel measure the real pause between turns.
  endAt: string
}

// Tie-break order when several entries share the same instant: speech first
// (it is what was happening), then chat, then the recorder's note last.
const KIND_ORDER: Record<TimelineEntry["kind"], number> = { speech: 0, chat: 1, note: 2 }

// Collapses consecutive utterances from the same speaker into one block, joining
// their text with a single space. Strictly order-preserving: a different speaker
// breaks the run, so an interruption splits a turn into before/after blocks in
// real chronological order (never reordered). The merged block keeps the first
// segment's startedAt. Empty/whitespace-only segment texts are dropped from the
// join so they never produce double spaces; a block whose every segment is empty
// still renders with an empty string.
export function mergeUtterances(utterances: Utterance[]): Utterance[] {
  const out: Utterance[] = []
  for (const utterance of utterances) {
    const last = out[out.length - 1]
    const piece = utterance.text.trim()
    if (last && last.speaker === utterance.speaker) {
      if (piece) last.text = last.text ? `${last.text} ${piece}` : piece
    } else {
      out.push({ speaker: utterance.speaker, startedAt: utterance.startedAt, text: piece })
    }
  }
  return out
}

// Combined chronological timeline WITHOUT same-speaker merge: one entry per
// utterance / chat message. Same sort and tie-break as mergeTimeline (at an
// identical instant, speech sorts before chat), but no run-collapsing. This is
// what the saved file consumes; the live panel still uses mergeTimeline.
export function flattenTimeline(transcript: Utterance[], chat: ChatMessage[], notes: Note[] = []): TimelineEntry[] {
  const raw: TimelineEntry[] = [
    ...transcript.map(
      (utterance): TimelineEntry => ({
        kind: "speech",
        speaker: utterance.speaker,
        text: utterance.text.trim(),
        at: utterance.startedAt,
        endAt: utterance.endedAt ?? utterance.startedAt,
      }),
    ),
    ...chat.map(
      (message): TimelineEntry => ({
        kind: "chat",
        speaker: message.sender,
        text: message.text,
        at: message.sentAt,
        endAt: message.sentAt,
      }),
    ),
    ...notes.map((note): TimelineEntry => ({ kind: "note", speaker: "", text: note.text, at: note.at, endAt: note.at })),
  ]
  return raw
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.at !== b.entry.at) return a.entry.at < b.entry.at ? -1 : 1
      if (a.entry.kind !== b.entry.kind) return KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind]
      return a.index - b.index
    })
    .map((x) => x.entry)
}

// A silence at least this long between the END of one utterance and the START of
// the next (same speaker) starts a new paragraph in the panel rather than continuing
// it. Measuring end->start (not start->start) is essential: Meet chops continuous
// speech into back-to-back phrase messageIds whose START times are seconds apart
// (that gap is the phrase's duration, not a pause), so a start-based check would
// break continuous speech on every phrase. Presentation-only: independent of
// feed.ts's data-level split (the saved file, from flattenTimeline, breaks on every
// utterance regardless).
const PARAGRAPH_GAP_MS = 4000

// Merge speech and chat into one chronological timeline (used by the live panel).
// Unlike mergeUtterances (which collapses by array adjacency), this interleaves by
// time FIRST so a chat dropped mid-monologue lands in its true position, THEN
// collapses consecutive same-speaker SPEECH - a chat or a different speaker breaks
// the run, and so does a real pause (>= PARAGRAPH_GAP_MS between the previous block's
// end and this entry's start), so the speaker falling silent and resuming splits it
// where it happened. Chat is never folded into a speaker's speech.
export function mergeTimeline(transcript: Utterance[], chat: ChatMessage[], notes: Note[] = []): TimelineEntry[] {
  const sorted = flattenTimeline(transcript, chat, notes)
  const out: TimelineEntry[] = []
  // End time of the current (last) block. The pause is measured from here to the next
  // entry's start, so continuous speech never breaks on a single phrase's length.
  let blockEndAt = ""
  for (const entry of sorted) {
    const last = out[out.length - 1]
    const continues =
      entry.kind === "speech" &&
      last &&
      last.kind === "speech" &&
      last.speaker === entry.speaker &&
      Date.parse(entry.at) - Date.parse(blockEndAt) < PARAGRAPH_GAP_MS
    if (continues) {
      // Same-speaker speech run within the gap: join (dropping empty pieces so no double spaces).
      if (entry.text) last.text = last.text ? `${last.text} ${entry.text}` : entry.text
      if (Date.parse(entry.endAt) > Date.parse(blockEndAt)) blockEndAt = entry.endAt
      last.endAt = blockEndAt
    } else {
      out.push({ ...entry })
      blockEndAt = entry.endAt
    }
  }
  return out
}

// Panel scroll helper, kept here (pure) so its threshold logic is unit-testable
// without a DOM. True when the scroll position is close enough to the bottom that
// new content should auto-scroll into view. Caller passes
// distanceFromBottom = scrollHeight - scrollTop - clientHeight.
export function isNearBottom(distanceFromBottom: number, threshold = 40): boolean {
  return distanceFromBottom <= threshold
}
