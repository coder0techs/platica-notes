import type { ChatMessage } from "../../shared/types"

/**
 * ChatLog collects chat messages with deduplication.
 *
 * When a stable message id is available (the collections channel carries a
 * "spaces/…/messages/…" resource name), it is authoritative: the same id is
 * dropped no matter when it re-arrives, because that channel re-syncs/replays
 * messages. A genuine double-send has a distinct id and is kept.
 *
 * Without an id (older/echoed messages), we fall back to consecutive dedup: drop
 * a message identical to the immediately preceding one (a repeated revision),
 * but keep a non-consecutive repeat (e.g. the same sender writing "+1" twice).
 */
export class ChatLog {
  private messages: ChatMessage[] = []
  private last: { sender: string; text: string } | null = null
  private seenIds = new Set<string>()

  add(message: ChatMessage, id?: string): boolean {
    if (id !== undefined) {
      if (this.seenIds.has(id)) return false
      this.seenIds.add(id)
    } else if (this.last && this.last.sender === message.sender && this.last.text === message.text) {
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
