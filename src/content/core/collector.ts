import type { ChatMessage, Utterance } from "../../shared/types"

export interface CaptionUpdate {
  blockKey: string
  speaker: string
  text: string
  at: string
}

interface OpenBlock {
  blockKey: string
  speaker: string
  startedAt: string
  text: string
}

export class TranscriptCollector {
  private done: Utterance[] = []
  private current: OpenBlock | null = null

  update(u: CaptionUpdate): void {
    if (!u.speaker.trim() || !u.text.trim()) return
    if (this.current && this.current.blockKey !== u.blockKey) {
      this.closeCurrent()
    }
    if (!this.current) {
      this.current = { blockKey: u.blockKey, speaker: u.speaker, startedAt: u.at, text: u.text }
    } else {
      this.current.text = u.text
    }
  }

  closeCurrent(): void {
    if (!this.current) return
    this.done.push({
      speaker: this.current.speaker,
      startedAt: this.current.startedAt,
      text: this.current.text.trim(),
    })
    this.current = null
  }

  snapshot(): Utterance[] {
    const all = [...this.done]
    if (this.current) {
      all.push({
        speaker: this.current.speaker,
        startedAt: this.current.startedAt,
        text: this.current.text.trim(),
      })
    }
    return all
  }
}

/**
 * ChatLog collects chat messages with consecutive deduplication.
 *
 * The DOM mutation observer fires multiple times for the same last message
 * (e.g. when attributes change on an existing node), so we drop a message
 * that is identical to the immediately preceding one. Non-consecutive repeats
 * (e.g. the same sender writing "+1" twice during a meeting) are real messages
 * and must be kept.
 */
export class ChatLog {
  private messages: ChatMessage[] = []
  private lastKey: string | null = null

  add(message: ChatMessage): boolean {
    const key = `${message.sender}\u0000${message.text}`
    if (key === this.lastKey) return false
    this.messages.push(message)
    this.lastKey = key
    return true
  }

  snapshot(): ChatMessage[] {
    return [...this.messages]
  }
}
