// Pure accumulator turning bridge events (see bridge.ts) into the session's
// transcript/chat arrays. No DOM, no chrome.*, no timers — callers stamp
// timestamps in, so the whole thing is unit-testable.

import type { ChatMessage, Utterance } from "../../shared/types"
import { ChatLog } from "../core/collector"
import type { RtcCaptionEvent, RtcChatEvent, RtcDeviceEvent } from "./bridge"

interface CaptionState {
  /** Global first-seen counter; snapshot order, independent of revision arrival. */
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

  handleDevice(ev: RtcDeviceEvent): void {
    this.roster.set(ev.deviceId, ev.deviceName)
  }

  /** Returns true if appended (not a consecutive duplicate). */
  handleChat(ev: RtcChatEvent, at: string): boolean {
    return this.chat.add({ sender: this.speakerFor(ev.deviceId), sentAt: at, text: ev.text })
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
