// Pure accumulator turning capture events (see capture/protocol.ts) into the
// session's transcript/chat arrays. No DOM, no chrome.*, no timers — callers stamp
// timestamps in, so the whole thing is unit-testable.

import type { CaptionHistory, ChatMessage, Utterance } from "../../shared/types"
import { ChatLog } from "./collector"
import type { ChatEvent, UtteranceEvent } from "../capture/protocol"

/**
 * The three behaviours that genuinely differ between meeting platforms. Everything
 * else in this file is platform-neutral, so a new platform supplies data here rather
 * than branching inside the accumulator.
 */
export interface CaptionRules {
  /**
   * Meet keeps one utteranceId growing even after another speaker interjects, so a
   * single id can span an interruption. Anchoring all of its text at the first-seen
   * time sorts the post-interruption words back before the interrupter and breaks
   * chronology. When this is set we split such an id into segments — each a block
   * with its own start time — once another speaker spoke AND this utterance had gone
   * quiet for at least this long. (A solo pause is NOT split: Meet already starts a
   * fresh id after a real pause, so there is nothing to fix and splitting a lone id
   * would only fragment it.)
   *
   * `null` for a platform that starts a fresh utterance id per turn — there the
   * split heuristics could only do harm.
   */
  interruptionGapMs: number | null
  /**
   * Label for a speaker the roster cannot name (yet). Platform-specific because the
   * id shape is: Meet's `spaces/<id>/devices/<n>` has a short stable tail worth
   * showing, an opaque numeric id does not.
   */
  speakerLabel: (speakerId: string) => string
  /**
   * The local user's own outgoing chat can arrive on two independent transports (on
   * Meet: the meet_messages send hook, id "self-out/…", and the embedded Google Chat
   * frame, id "self-topic/…"). Both can fire for a single send, and because their
   * dedup ids differ, ChatLog's id dedup cannot collapse them. With this set, a
   * self-authored message (id prefixed "self-") whose exact text was already accepted
   * inside the window is treated as the other transport's copy and dropped; a genuine
   * re-send arrives well outside it and is kept.
   *
   * `null` for a platform with a single own-chat transport.
   */
  selfChatDedupMs: number | null
}

const isSelfChatId = (id?: string): boolean => id !== undefined && id.startsWith("self-")

const elapsedMs = (fromIso: string, toIso: string): number => Date.parse(toIso) - Date.parse(fromIso)

// A word for prefix comparison, folded the same way collapseVersions folds frames:
// lowercased with punctuation stripped, so Meet's case/punctuation churn between
// frames does not defeat the match.
const normWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

// The tail of `full` that follows the words already shown in `base` — i.e. the new
// words a split segment should carry. Matching is word-wise and normalized. When
// `base` is not a clean prefix (Meet reworded an earlier word), we return the
// remainder from the first divergence: at worst a word is duplicated at the seam,
// never dropped. An empty base returns the whole (trimmed) text.
export function suffixAfter(full: string, base: string): string {
  const trimmed = full.trim()
  if (!base.trim()) return trimmed
  const fullWords = trimmed.split(/\s+/)
  const baseWords = base.trim().split(/\s+/)
  let i = 0
  while (i < baseWords.length && i < fullWords.length && normWord(fullWords[i]) === normWord(baseWords[i])) i++
  return fullWords.slice(i).join(" ")
}

// One block of a messageId: the text spoken between two split points. `base` is the
// cumulative text owned by earlier segments (the prefix suffixAfter strips off).
interface Segment {
  startedAt: string
  // Time the text last GREW (reached its length). Marks the spoken end of the
  // segment, ignoring Meet's late no-growth flush revisions — so the panel can tell
  // a long phrase from a real pause.
  endedAt: string
  base: string
  text: string
  // Every distinct text this segment took, in order (already prefix-stripped).
  // Consecutive identical frames are deduped on push.
  versions: string[]
}

interface CaptionState {
  // First-seen counter used for snapshot ordering. Entries are insert-only (revisions
  // mutate in place), so Map insertion order already equals first-seen order and the
  // sort is currently a no-op; the field is kept as a defence against future
  // reinsertion of entries (e.g. merge/replay logic).
  order: number
  speakerId: string
  version: number
  // Latest cumulative full text of the whole messageId (staleness guard + the base
  // handed to the next segment on a split).
  fullText: string
  // Arrival time of the last accepted revision — drives the pause-based split rules.
  lastAt: string
  // One or more blocks; a split appends a new one. Always at least one entry.
  segments: Segment[]
}

export class CaptureFeed {
  // Keyed by speakerId + "/" + utteranceId: an utterance id alone is only unique
  // per speaker.
  private captions = new Map<string, CaptionState>()
  private nextOrder = 0
  // The speakerId of the most recently accepted caption event. Between two revisions
  // of the same utteranceId every event is by definition from another speaker, so
  // "the last caption was not from this speaker" is exactly "someone else spoke since
  // my last revision" — O(1), no scan. Chat does not touch this (it never splits speech).
  private lastEventSpeakerId = ""
  private chat = new ChatLog()
  // text → ms of the last accepted self-authored chat, for cross-transport dedup.
  private lastSelfChatAt = new Map<string, number>()
  private roster: Map<string, string>

  // The roster map can be shared with the caller (it streams from join time,
  // before a meeting's feed exists) — names then resolve retroactively at
  // snapshot time without replaying roster events into the feed. The local user's
  // own speakerId → name is added to it like any participant (on Meet, from the
  // UpdateMeetingDevice RPC), so self resolves through the roster too.
  //
  // `rules` is the platform's caption semantics; it has no default on purpose, so a
  // new platform has to state them rather than silently inherit Meet's.
  constructor(
    roster: Map<string, string> = new Map(),
    private readonly rules: CaptionRules,
  ) {
    this.roster = roster
  }

  /**
   * Wipe all captured content (transcript, chat, and their dedup/order state) so
   * capture restarts from an empty base. The roster (deviceId -> name) is KEPT: it
   * is identity, not content, and turns captured after a wipe still need it to
   * resolve speaker names.
   */
  reset(): void {
    this.captions.clear()
    this.nextOrder = 0
    this.lastEventSpeakerId = ""
    this.chat = new ChatLog()
    this.lastSelfChatAt.clear()
  }

  /** Returns true if the revision was accepted (not stale). */
  handleCaption(ev: UtteranceEvent, at: string): boolean {
    const key = `${ev.speakerId}/${ev.utteranceId}`
    const existing = this.captions.get(key)
    if (existing) {
      if (ev.revision <= existing.version) return false

      const gap = this.rules.interruptionGapMs
      const otherSpoke = this.lastEventSpeakerId !== "" && this.lastEventSpeakerId !== ev.speakerId
      const sinceLast = elapsedMs(existing.lastAt, at)
      const shouldSplit = gap !== null && otherSpoke && sinceLast >= gap
      if (shouldSplit) {
        // Everything shown so far belongs to the closing segment; the new one carries
        // only the words that follow, timestamped at this revision.
        existing.segments.push({ startedAt: at, endedAt: at, base: existing.fullText, text: "", versions: [] })
      }

      existing.version = ev.revision
      existing.fullText = ev.text
      existing.lastAt = at
      const segment = existing.segments[existing.segments.length - 1]
      const prevLength = segment.text.length
      segment.text = suffixAfter(ev.text, segment.base)
      // Advance endedAt only when the text actually grew, so a late flush that
      // re-sends or shortens the text does not stretch the segment's end past when
      // it was really spoken.
      if (segment.text.length > prevLength) segment.endedAt = at
      if (segment.versions[segment.versions.length - 1] !== segment.text) {
        segment.versions.push(segment.text)
      }
      this.lastEventSpeakerId = ev.speakerId
      return true
    }
    const firstText = suffixAfter(ev.text, "")
    this.captions.set(key, {
      order: this.nextOrder++,
      speakerId: ev.speakerId,
      version: ev.revision,
      fullText: ev.text,
      lastAt: at,
      segments: [{ startedAt: at, endedAt: at, base: "", text: firstText, versions: [firstText] }],
    })
    this.lastEventSpeakerId = ev.speakerId
    return true
  }

  /** Returns true if appended (not a consecutive duplicate). */
  handleChat(ev: ChatEvent, at: string): boolean {
    // Cross-transport dedup for the user's own chat: the same send can arrive on
    // both self transports with different ids, so collapse a self message whose
    // exact text was just accepted (see CaptionRules.selfChatDedupMs).
    const selfWindow = this.rules.selfChatDedupMs
    if (selfWindow !== null && isSelfChatId(ev.messageId)) {
      const textKey = ev.text.trim()
      const atMs = Date.parse(at)
      const prev = this.lastSelfChatAt.get(textKey)
      if (prev !== undefined && atMs - prev < selfWindow) return false
      this.lastSelfChatAt.set(textKey, atMs)
    }
    // Sender resolved at append time, not at snapshot time (unlike transcript speakers).
    // Deliberate: chat needs a human-readable name immediately (seconds after join,
    // before the roster is fully streamed); transcripts can afford retroactive resolution.
    // Precedence: the display name embedded in the chat packet wins (it ships with the
    // message); otherwise fall back to the roster lookup / deviceId-tail label.
    // Harvest the embedded sender into the roster first: a chat message teaches
    // the feed this deviceId->name mapping, so transcript lines from the same
    // device — including the local user, who never appears in the collections
    // roster — resolve to the real name at snapshot time (both later and prior,
    // since transcript speakers resolve at snapshot time).
    if (ev.sender && ev.sender.trim()) this.roster.set(ev.speakerId, ev.sender)
    const sender = ev.sender && ev.sender.trim() ? ev.sender : this.speakerFor(ev.speakerId)
    return this.chat.add({ sender, sentAt: at, text: ev.text }, ev.messageId)
  }

  transcriptSnapshot(): Utterance[] {
    // One utterance per segment. Empty segments (a split boundary that a later
    // revision has not yet filled) are dropped so they never emit a blank turn.
    return [...this.captions.values()]
      .sort((a, b) => a.order - b.order)
      .flatMap((c) =>
        c.segments
          .filter((s) => s.text.trim() !== "")
          .map((s) => ({ speaker: this.speakerFor(c.speakerId), startedAt: s.startedAt, endedAt: s.endedAt, text: s.text })),
      )
  }

  versionsSnapshot(): CaptionHistory[] {
    // Mirrors transcriptSnapshot's per-segment split (same filter) so each turn's
    // alternatives stay attached to it — the format keys alts by (speaker, startedAt).
    return [...this.captions.values()]
      .sort((a, b) => a.order - b.order)
      .flatMap((c) =>
        c.segments
          .filter((s) => s.text.trim() !== "")
          .map((s) => ({ speaker: this.speakerFor(c.speakerId), startedAt: s.startedAt, versions: [...s.versions] })),
      )
  }

  chatSnapshot(): ChatMessage[] {
    return this.chat.snapshot()
  }

  private speakerFor(speakerId: string): string {
    // The roster is the single source of names — for remote participants and for
    // the local user, whose own deviceId → name the caller seeds from the
    // UpdateMeetingDevice RPC. A device with no roster entry yet falls back to a
    // stable per-device label; the snapshot re-resolves, so it picks up the real
    // name retroactively once the roster learns it.
    const name = this.roster.get(speakerId)
    if (name) return name
    return this.rules.speakerLabel(speakerId)
  }
}
