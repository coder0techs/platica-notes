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

export class ChatLog {
  private messages: ChatMessage[] = []
  private seen = new Set<string>()

  add(message: ChatMessage): boolean {
    const key = `${message.sender}\u0000${message.text}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    this.messages.push(message)
    return true
  }

  snapshot(): ChatMessage[] {
    return [...this.messages]
  }
}
