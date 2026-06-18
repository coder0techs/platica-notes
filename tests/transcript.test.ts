import { describe, expect, it } from "vitest"
import { isNearBottom, mergeTimeline, mergeUtterances } from "../src/shared/transcript"
import type { ChatMessage, Utterance } from "../src/shared/types"

const u = (speaker: string, startedAt: string, text: string): Utterance => ({ speaker, startedAt, text })
const cm = (sender: string, sentAt: string, text: string): ChatMessage => ({ sender, sentAt, text })

describe("mergeUtterances", () => {
  it("merges consecutive same-speaker utterances into one block joined by spaces", () => {
    const out = mergeUtterances([
      u("Alice", "2026-06-10T10:01:00.000Z", "Hello"),
      u("Alice", "2026-06-10T10:01:05.000Z", "everyone here"),
    ])
    expect(out).toEqual([u("Alice", "2026-06-10T10:01:00.000Z", "Hello everyone here")])
  })

  it("keeps the first segment's startedAt for a merged block", () => {
    const out = mergeUtterances([
      u("Alice", "2026-06-10T10:01:00.000Z", "a"),
      u("Alice", "2026-06-10T10:02:00.000Z", "b"),
    ])
    expect(out[0].startedAt).toBe("2026-06-10T10:01:00.000Z")
  })

  it("does not merge different speakers", () => {
    const out = mergeUtterances([
      u("Alice", "2026-06-10T10:01:00.000Z", "hi"),
      u("Bob", "2026-06-10T10:01:01.000Z", "yo"),
    ])
    expect(out).toHaveLength(2)
  })

  it("splits a turn around an interruption (A-B-A stays three blocks, in order)", () => {
    const out = mergeUtterances([
      u("Alice", "2026-06-10T10:01:00.000Z", "first part"),
      u("Bob", "2026-06-10T10:01:02.000Z", "I interject"),
      u("Alice", "2026-06-10T10:01:05.000Z", "second part"),
    ])
    expect(out.map((x) => x.speaker)).toEqual(["Alice", "Bob", "Alice"])
    expect(out[0].text).toBe("first part")
    expect(out[2].text).toBe("second part")
  })

  it("returns an empty array unchanged", () => {
    expect(mergeUtterances([])).toEqual([])
  })

  it("returns a single utterance as one trimmed block", () => {
    expect(mergeUtterances([u("Alice", "2026-06-10T10:01:00.000Z", "  hi  ")])).toEqual([
      u("Alice", "2026-06-10T10:01:00.000Z", "hi"),
    ])
  })

  it("drops empty/whitespace segments from the join so there are no double spaces", () => {
    const out = mergeUtterances([
      u("Alice", "2026-06-10T10:01:00.000Z", "hello"),
      u("Alice", "2026-06-10T10:01:01.000Z", "   "),
      u("Alice", "2026-06-10T10:01:02.000Z", "world"),
    ])
    expect(out).toEqual([u("Alice", "2026-06-10T10:01:00.000Z", "hello world")])
  })

  it("yields empty text for a block whose every segment is empty", () => {
    const out = mergeUtterances([
      u("Alice", "2026-06-10T10:01:00.000Z", ""),
      u("Alice", "2026-06-10T10:01:01.000Z", "  "),
    ])
    expect(out).toEqual([u("Alice", "2026-06-10T10:01:00.000Z", "")])
  })
})

describe("mergeTimeline", () => {
  it("interleaves speech and chat in chronological order", () => {
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "morning"),
        u("Alice", "2026-06-10T10:03:00.000Z", "as I said"),
      ],
      [cm("Bob", "2026-06-10T10:02:00.000Z", "here is the link")],
    )
    expect(out.map((e) => [e.kind, e.speaker, e.at])).toEqual([
      ["speech", "Alice", "2026-06-10T10:01:00.000Z"],
      ["chat", "Bob", "2026-06-10T10:02:00.000Z"],
      ["speech", "Alice", "2026-06-10T10:03:00.000Z"],
    ])
  })

  it("keeps chat as its own entry — never merged into a speaker's speech", () => {
    const out = mergeTimeline(
      [u("Alice", "2026-06-10T10:01:00.000Z", "hi")],
      [cm("Alice", "2026-06-10T10:01:30.000Z", "(see chat)")],
    )
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ kind: "chat", speaker: "Alice", text: "(see chat)", at: "2026-06-10T10:01:30.000Z" })
  })

  it("orders speech before chat at the same instant", () => {
    const out = mergeTimeline(
      [u("Alice", "2026-06-10T10:01:00.000Z", "look")],
      [cm("Alice", "2026-06-10T10:01:00.000Z", "https://x")],
    )
    expect(out.map((e) => e.kind)).toEqual(["speech", "chat"])
  })

  it("collapses consecutive same-speaker speech before interleaving", () => {
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "one"),
        u("Alice", "2026-06-10T10:01:05.000Z", "two"),
      ],
      [],
    )
    expect(out).toEqual([{ kind: "speech", speaker: "Alice", text: "one two", at: "2026-06-10T10:01:00.000Z" }])
  })

  it("returns only chat when there is no transcript", () => {
    const out = mergeTimeline([], [cm("Bob", "2026-06-10T10:00:00.000Z", "hello")])
    expect(out).toEqual([{ kind: "chat", speaker: "Bob", text: "hello", at: "2026-06-10T10:00:00.000Z" }])
  })

  it("returns an empty array when both inputs are empty", () => {
    expect(mergeTimeline([], [])).toEqual([])
  })
})

describe("isNearBottom", () => {
  it("is true when exactly at the bottom", () => {
    expect(isNearBottom(0)).toBe(true)
  })

  it("is true at the default threshold boundary", () => {
    expect(isNearBottom(40)).toBe(true)
  })

  it("is false just past the default threshold", () => {
    expect(isNearBottom(41)).toBe(false)
  })

  it("honors a custom threshold", () => {
    expect(isNearBottom(100, 120)).toBe(true)
    expect(isNearBottom(150, 120)).toBe(false)
  })
})
