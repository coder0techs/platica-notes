import { describe, expect, it } from "vitest"
import { ChatLog, TranscriptCollector } from "../src/content/core/collector"

const at = "2026-06-10T10:00:00.000Z"

describe("TranscriptCollector", () => {
  it("replaces text on updates within the same block", () => {
    const c = new TranscriptCollector()
    c.update({ blockKey: "1", speaker: "Alice", text: "Hel", at })
    c.update({ blockKey: "1", speaker: "Alice", text: "Hello there", at })
    expect(c.snapshot()).toEqual([{ speaker: "Alice", startedAt: at, text: "Hello there" }])
  })

  it("finalizes the previous block when blockKey changes", () => {
    const c = new TranscriptCollector()
    c.update({ blockKey: "1", speaker: "Alice", text: "Hello", at })
    c.update({ blockKey: "2", speaker: "Bob", text: "Hi", at })
    const result = c.snapshot()
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ speaker: "Alice", startedAt: at, text: "Hello" })
    expect(result[1].speaker).toBe("Bob")
  })

  it("keeps the first timestamp of a block", () => {
    const c = new TranscriptCollector()
    c.update({ blockKey: "1", speaker: "Alice", text: "He", at })
    c.update({ blockKey: "1", speaker: "Alice", text: "Hello", at: "2026-06-10T10:00:09.000Z" })
    expect(c.snapshot()[0].startedAt).toBe(at)
  })

  it("ignores updates with blank speaker or text", () => {
    const c = new TranscriptCollector()
    c.update({ blockKey: "1", speaker: " ", text: "Hello", at })
    c.update({ blockKey: "1", speaker: "Alice", text: "", at })
    expect(c.snapshot()).toEqual([])
  })

  it("closeCurrent finalizes and trims the open block", () => {
    const c = new TranscriptCollector()
    c.update({ blockKey: "1", speaker: "Alice", text: "  Hello  ", at })
    c.closeCurrent()
    c.update({ blockKey: "1", speaker: "Alice", text: "Again", at })
    const result = c.snapshot()
    expect(result[0].text).toBe("Hello")
    expect(result).toHaveLength(2)
  })

  it("same speaker with a new blockKey produces two utterances (monologue split)", () => {
    const c = new TranscriptCollector()
    c.update({ blockKey: "a1", speaker: "Alice", text: "First thought", at })
    c.update({ blockKey: "a2", speaker: "Alice", text: "Second thought", at })
    const result = c.snapshot()
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe("First thought")
    expect(result[1].text).toBe("Second thought")
    expect(result[0].speaker).toBe("Alice")
    expect(result[1].speaker).toBe("Alice")
  })

  it("snapshot returns an isolated copy — mutating it does not affect subsequent snapshots", () => {
    const c = new TranscriptCollector()
    c.update({ blockKey: "1", speaker: "Alice", text: "Hello", at })
    c.closeCurrent()
    const first = c.snapshot()
    first.push({ speaker: "Mutant", startedAt: at, text: "injected" })
    const second = c.snapshot()
    expect(second).toHaveLength(1)
    expect(second[0].speaker).toBe("Alice")
  })
})

describe("ChatLog", () => {
  it("adds a new message and reports true", () => {
    const log = new ChatLog()
    expect(log.add({ sender: "Alice", sentAt: at, text: "hi" })).toBe(true)
    expect(log.snapshot()).toHaveLength(1)
  })

  it("drops consecutive identical sender+text (DOM mutation burst)", () => {
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
})
