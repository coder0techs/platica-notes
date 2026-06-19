import type { ChatMessage, Utterance } from "./types"

// One row of the unified meeting timeline: a merged speech turn or a chat message.
export interface TimelineEntry {
  kind: "speech" | "chat"
  speaker: string
  text: string
  at: string // ISO 8601
}

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
export function flattenTimeline(transcript: Utterance[], chat: ChatMessage[]): TimelineEntry[] {
  const raw: TimelineEntry[] = [
    ...transcript.map(
      (utterance): TimelineEntry => ({
        kind: "speech",
        speaker: utterance.speaker,
        text: utterance.text.trim(),
        at: utterance.startedAt,
      }),
    ),
    ...chat.map(
      (message): TimelineEntry => ({ kind: "chat", speaker: message.sender, text: message.text, at: message.sentAt }),
    ),
  ]
  return raw
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.at !== b.entry.at) return a.entry.at < b.entry.at ? -1 : 1
      if (a.entry.kind !== b.entry.kind) return a.entry.kind === "speech" ? -1 : 1
      return a.index - b.index
    })
    .map((x) => x.entry)
}

// Merge speech and chat into one chronological timeline (used by the live panel).
// Unlike mergeUtterances (which collapses by array adjacency), this interleaves by
// time FIRST so a chat dropped mid-monologue lands in its true position, THEN
// collapses consecutive same-speaker SPEECH - a chat or a different speaker breaks
// the run, so a link pasted during a long turn splits it where it happened. Chat is
// never folded into a speaker's speech.
export function mergeTimeline(transcript: Utterance[], chat: ChatMessage[]): TimelineEntry[] {
  const sorted = flattenTimeline(transcript, chat)
  const out: TimelineEntry[] = []
  for (const entry of sorted) {
    const last = out[out.length - 1]
    if (entry.kind === "speech" && last && last.kind === "speech" && last.speaker === entry.speaker) {
      // Same-speaker speech run: join (dropping empty pieces so no double spaces).
      if (entry.text) last.text = last.text ? `${last.text} ${entry.text}` : entry.text
    } else {
      out.push({ ...entry })
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
