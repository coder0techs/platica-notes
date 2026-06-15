import { describe, expect, it } from "vitest"
import { RtcFeed } from "../src/content/meet-rtc/feed"
import type { RtcCaptionEvent, RtcChatEvent } from "../src/content/meet-rtc/bridge"

const at = "2026-06-11T10:00:00.000Z"
const later = "2026-06-11T10:00:05.000Z"

const caption = (
  deviceId: string,
  messageId: number,
  messageVersion: number,
  text: string,
): RtcCaptionEvent => ({ type: "transcript", deviceId, messageId, messageVersion, text })

const chat = (deviceId: string, text: string, sender?: string): RtcChatEvent =>
  sender === undefined ? { type: "chat", deviceId, text } : { type: "chat", deviceId, text, sender }

const ALICE = "spaces/abc/devices/1"
const BOB = "spaces/abc/devices/2"

describe("RtcFeed transcript", () => {
  it("starts with empty snapshots", () => {
    const feed = new RtcFeed()
    expect(feed.transcriptSnapshot()).toEqual([])
    expect(feed.chatSnapshot()).toEqual([])
  })

  it("accepts a higher version and replaces the text", () => {
    const feed = new RtcFeed()
    expect(feed.handleCaption(caption(ALICE, 1, 1, "Hel"), at)).toBe(true)
    expect(feed.handleCaption(caption(ALICE, 1, 2, "Hello there"), later)).toBe(true)
    expect(feed.transcriptSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: at, text: "Hello there" },
    ])
  })

  it("rejects a stale version without changing state", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 3, "Final text"), at)
    expect(feed.handleCaption(caption(ALICE, 1, 2, "Older revision"), later)).toBe(false)
    expect(feed.handleCaption(caption(ALICE, 1, 3, "Same version"), later)).toBe(false)
    expect(feed.transcriptSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: at, text: "Final text" },
    ])
  })

  it("keeps interleaved speakers as separate utterances in first-seen order", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    feed.handleCaption(caption(BOB, 7, 1, "Hi"), at)
    feed.handleCaption(caption(ALICE, 1, 2, "Hello everyone"), later)
    const result = feed.transcriptSnapshot()
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ speaker: "Speaker 1", startedAt: at, text: "Hello everyone" })
    expect(result[1]).toEqual({ speaker: "Speaker 2", startedAt: at, text: "Hi" })
  })

  it("resolves names retroactively when the roster arrives after speech", () => {
    const roster = new Map<string, string>()
    const feed = new RtcFeed(roster)
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Speaker 1")
    roster.set(ALICE, "Alice García")
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Alice García")
  })

  it("falls back to the deviceId tail, or the whole id without slashes", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption("spaces/abc/devices/42", 1, 1, "Tail"), at)
    feed.handleCaption(caption("opaque-id", 2, 1, "Whole"), at)
    const result = feed.transcriptSnapshot()
    expect(result[0].speaker).toBe("Speaker 42")
    expect(result[1].speaker).toBe("Speaker opaque-id")
  })

  it("keeps multiple messages from the same device in order", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "First thought"), at)
    feed.handleCaption(caption(ALICE, 2, 1, "Second thought"), later)
    feed.handleCaption(caption(ALICE, 1, 2, "First thought, revised"), later)
    const result = feed.transcriptSnapshot()
    expect(result.map((u) => u.text)).toEqual(["First thought, revised", "Second thought"])
    expect(result[0].startedAt).toBe(at)
    expect(result[1].startedAt).toBe(later)
  })
})

describe("RtcFeed chat", () => {
  it("drops consecutive duplicates and keeps non-consecutive repeats", () => {
    const feed = new RtcFeed()
    expect(feed.handleChat(chat(ALICE, "+1"), at)).toBe(true)
    expect(feed.handleChat(chat(ALICE, "+1"), later)).toBe(false)
    expect(feed.handleChat(chat(BOB, "hello"), later)).toBe(true)
    expect(feed.handleChat(chat(ALICE, "+1"), later)).toBe(true)
    expect(feed.chatSnapshot()).toHaveLength(3)
  })

  it("prefers the embedded sender over the roster entry", () => {
    const roster = new Map([[ALICE, "Roster Name"]])
    const feed = new RtcFeed(roster)
    feed.handleChat(chat(ALICE, "hi", "Embedded Name"), at)
    expect(feed.chatSnapshot()).toEqual([{ sender: "Embedded Name", sentAt: at, text: "hi" }])
  })

  it("falls back to the roster when no embedded sender is present", () => {
    const roster = new Map([[ALICE, "Alice García"]])
    const feed = new RtcFeed(roster)
    feed.handleChat(chat(ALICE, "hi"), at)
    expect(feed.chatSnapshot()).toEqual([{ sender: "Alice García", sentAt: at, text: "hi" }])
  })

  it("ignores a blank embedded sender and falls back to the roster", () => {
    const roster = new Map([[ALICE, "Alice García"]])
    const feed = new RtcFeed(roster)
    feed.handleChat(chat(ALICE, "hi", "   "), at)
    expect(feed.chatSnapshot()[0].sender).toBe("Alice García")
  })

  it("falls back to the deviceId tail when neither sender nor roster is known", () => {
    const feed = new RtcFeed()
    feed.handleChat(chat(BOB, "hi"), at)
    expect(feed.chatSnapshot()[0].sender).toBe("Speaker 2")
  })

  it("does NOT retroactively rename a chat sender when the roster entry arrives later", () => {
    // Chat sender is resolved at append time; unlike transcript speakers it is
    // frozen into the ChatLog entry and will not change even if the roster
    // is populated afterwards. This is deliberate — see handleChat comment.
    const roster = new Map<string, string>()
    const feed = new RtcFeed(roster)
    feed.handleChat(chat(ALICE, "hello"), at)
    expect(feed.chatSnapshot()[0].sender).toBe("Speaker 1")
    roster.set(ALICE, "Alice García")
    // Snapshot still shows the name that was resolved at append time.
    expect(feed.chatSnapshot()[0].sender).toBe("Speaker 1")
  })
})

describe("RtcFeed shared roster", () => {
  it("uses a caller-provided roster map populated externally", () => {
    const roster = new Map<string, string>()
    const feed = new RtcFeed(roster)
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    roster.set(ALICE, "Alice García")
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Alice García")
  })
})
