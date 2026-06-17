import type { Utterance } from "./types"

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
      last.text = last.text ? (piece ? `${last.text} ${piece}` : last.text) : piece
    } else {
      out.push({ speaker: utterance.speaker, startedAt: utterance.startedAt, text: piece })
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
