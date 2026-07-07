import { describe, expect, it } from "vitest"
import { ChatLog } from "../src/content/core/collector"

const at = "2026-06-10T10:00:00.000Z"

describe("ChatLog", () => {
  it("adds a new message and reports true", () => {
    const log = new ChatLog()
    expect(log.add({ sender: "Alice", sentAt: at, text: "hi" })).toBe(true)
    expect(log.snapshot()).toHaveLength(1)
  })

  it("drops consecutive identical sender+text (repeated revision)", () => {
    const log = new ChatLog()
    log.add({ sender: "Alice", sentAt: at, text: "hi" })
    expect(log.add({ sender: "Alice", sentAt: "2026-06-10T10:05:00.000Z", text: "hi" })).toBe(false)
    expect(log.snapshot()).toHaveLength(1)
  })

  it("keeps non-consecutive repeat (same sender writes same text later)", () => {
    const log = new ChatLog()
    log.add({ sender: "Alice", sentAt: at, text: "hi" })
    log.add({ sender: "Bob", sentAt: at, text: "hello" })
    expect(log.add({ sender: "Alice", sentAt: at, text: "hi" })).toBe(true)
    expect(log.snapshot()).toHaveLength(3)
  })

  it("allows same text from different senders", () => {
    const log = new ChatLog()
    log.add({ sender: "Alice", sentAt: at, text: "hi" })
    expect(log.add({ sender: "Bob", sentAt: at, text: "hi" })).toBe(true)
  })

  it("drops a message whose id was already seen, even non-consecutively", () => {
    // The collections channel re-syncs/replays messages, so the same message can
    // arrive again after other messages — the consecutive guard would miss it.
    const log = new ChatLog()
    log.add({ sender: "Alice", sentAt: at, text: "hi" }, "spaces/x/messages/m1")
    log.add({ sender: "Bob", sentAt: at, text: "hello" }, "spaces/x/messages/m2")
    expect(log.add({ sender: "Alice", sentAt: at, text: "hi" }, "spaces/x/messages/m1")).toBe(false)
    expect(log.snapshot()).toHaveLength(2)
  })

  it("keeps two distinct-id messages with identical sender+text", () => {
    // A real double-send (distinct ids) must survive even though the text is
    // identical and consecutive — the id is authoritative when present.
    const log = new ChatLog()
    log.add({ sender: "Alice", sentAt: at, text: "+1" }, "spaces/x/messages/m1")
    expect(log.add({ sender: "Alice", sentAt: at, text: "+1" }, "spaces/x/messages/m2")).toBe(true)
    expect(log.snapshot()).toHaveLength(2)
  })
})
