import type { ChatMessage } from "../../shared/types"

/**
 * ChatLog collects chat messages with consecutive deduplication.
 *
 * The same chat message can arrive more than once (a repeated revision over the
 * data channel), so we drop a message identical to the immediately preceding
 * one. Non-consecutive repeats (e.g. the same sender writing "+1" twice during
 * a meeting) are real messages and must be kept.
 */
export class ChatLog {
  private messages: ChatMessage[] = []
  private last: { sender: string; text: string } | null = null

  add(message: ChatMessage): boolean {
    if (this.last && this.last.sender === message.sender && this.last.text === message.text) {
      return false
    }
    this.messages.push(message)
    this.last = { sender: message.sender, text: message.text }
    return true
  }

  snapshot(): ChatMessage[] {
    return [...this.messages]
  }
}
