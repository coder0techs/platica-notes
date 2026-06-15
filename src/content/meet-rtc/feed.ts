// Pure accumulator turning bridge events (see bridge.ts) into the session's
// transcript/chat arrays. No DOM, no chrome.*, no timers — callers stamp
// timestamps in, so the whole thing is unit-testable.

import type { ChatMessage, Utterance } from "../../shared/types"
import { ChatLog } from "../core/collector"
import type { RtcCaptionEvent, RtcChatEvent } from "./bridge"

interface CaptionState {
  // First-seen counter used for snapshot ordering. Entries are insert-only (revisions
  // mutate in place), so Map insertion order already equals first-seen order and the
  // sort is currently a no-op; the field is kept as a defence against future
  // reinsertion of entries (e.g. merge/replay logic).
  order: number
  deviceId: string
  startedAt: string
  text: string
  version: number
}

export class RtcFeed {
  // Keyed by deviceId + "/" + messageId: messageId alone is only unique per device.
  private captions = new Map<string, CaptionState>()
  private nextOrder = 0
  private chat = new ChatLog()
  private roster: Map<string, string>

  // The roster map can be shared with the caller (it streams from join time,
  // before a meeting's feed exists) — names then resolve retroactively at
  // snapshot time without replaying device events into the feed.
  constructor(roster: Map<string, string> = new Map()) {
    this.roster = roster
  }

  /** Returns true if the revision was accepted (not stale). */
  handleCaption(ev: RtcCaptionEvent, at: string): boolean {
    const key = `${ev.deviceId}/${ev.messageId}`
    const existing = this.captions.get(key)
    if (existing) {
      if (ev.messageVersion <= existing.version) return false
      existing.text = ev.text
      existing.version = ev.messageVersion
      return true
    }
    this.captions.set(key, {
      order: this.nextOrder++,
      deviceId: ev.deviceId,
      startedAt: at,
      text: ev.text,
      version: ev.messageVersion,
    })
    return true
  }

  /** Returns true if appended (not a consecutive duplicate). */
  handleChat(ev: RtcChatEvent, at: string): boolean {
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
    if (ev.sender && ev.sender.trim()) this.roster.set(ev.deviceId, ev.sender)
    const sender = ev.sender && ev.sender.trim() ? ev.sender : this.speakerFor(ev.deviceId)
    return this.chat.add({ sender, sentAt: at, text: ev.text })
  }

  transcriptSnapshot(): Utterance[] {
    return [...this.captions.values()]
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ speaker: this.speakerFor(c.deviceId), startedAt: c.startedAt, text: c.text }))
  }

  chatSnapshot(): ChatMessage[] {
    return this.chat.snapshot()
  }

  private speakerFor(deviceId: string): string {
    const name = this.roster.get(deviceId)
    if (name) return name
    // Meet device ids look like spaces/<id>/devices/<n> — the tail is short and
    // stable enough to tell speakers apart when the roster has no entry (yet).
    const tail = deviceId.slice(deviceId.lastIndexOf("/") + 1)
    return `Speaker ${tail || deviceId}`
  }
}
