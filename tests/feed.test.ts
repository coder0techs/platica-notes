import { describe, expect, it } from "vitest"
import { RtcFeed, suffixAfter } from "../src/content/capture/meet/feed"
import type { ChatEvent, UtteranceEvent } from "../src/content/capture/protocol"

const at = "2026-06-11T10:00:00.000Z"
// A sub-second bump: close enough that none of the interruption-split thresholds
// (see the "interruption split" block) fire, so these tests exercise plain
// revision/dedup/name-resolution behaviour without an accidental split.
const later = "2026-06-11T10:00:00.500Z"

// Absolute ISO timestamp `ms` milliseconds after `at`; lets a test place caption
// revisions at precise offsets to drive the interruption-split thresholds.
const t = (ms: number): string => new Date(Date.parse(at) + ms).toISOString()

// The canonical protocol keys utterances by STRING id (a platform id can be opaque),
// so these factories take Meet-shaped numbers and stringify, keeping every call site
// below unchanged.
const caption = (
  speakerId: string,
  utteranceId: number,
  revision: number,
  text: string,
): UtteranceEvent => ({ type: "utterance", speakerId, utteranceId: String(utteranceId), revision, text })

const chat = (speakerId: string, text: string, sender?: string): ChatEvent =>
  sender === undefined ? { type: "chat", speakerId, text } : { type: "chat", speakerId, text, sender }

const chatWithId = (speakerId: string, text: string, messageId: string): ChatEvent => ({
  type: "chat",
  speakerId,
  text,
  messageId,
})

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
      { speaker: "Speaker 1", startedAt: at, endedAt: later, text: "Hello there" },
    ])
  })

  it("rejects a stale version without changing state", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 3, "Final text"), at)
    expect(feed.handleCaption(caption(ALICE, 1, 2, "Older revision"), later)).toBe(false)
    expect(feed.handleCaption(caption(ALICE, 1, 3, "Same version"), later)).toBe(false)
    expect(feed.transcriptSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: at, endedAt: at, text: "Final text" },
    ])
  })

  it("keeps interleaved speakers as separate utterances in first-seen order", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    feed.handleCaption(caption(BOB, 7, 1, "Hi"), at)
    feed.handleCaption(caption(ALICE, 1, 2, "Hello everyone"), later)
    const result = feed.transcriptSnapshot()
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ speaker: "Speaker 1", startedAt: at, endedAt: later, text: "Hello everyone" })
    expect(result[1]).toEqual({ speaker: "Speaker 2", startedAt: at, endedAt: at, text: "Hi" })
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

  it("dedupes a re-synced message by id, even non-consecutively", () => {
    // The collections channel replays messages, so the same id can re-arrive
    // after other messages. handleChat must thread messageId to the ChatLog.
    const feed = new RtcFeed()
    expect(feed.handleChat(chatWithId(ALICE, "hi", "spaces/abc/messages/m1"), at)).toBe(true)
    expect(feed.handleChat(chatWithId(BOB, "yo", "spaces/abc/messages/m2"), later)).toBe(true)
    expect(feed.handleChat(chatWithId(ALICE, "hi", "spaces/abc/messages/m1"), later)).toBe(false)
    expect(feed.chatSnapshot()).toHaveLength(2)
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

describe("RtcFeed chat harvests sender into roster", () => {
  it("teaches the feed deviceId->name so transcript lines from that device resolve", () => {
    const feed = new RtcFeed()
    feed.handleChat(chat(ALICE, "hi", "Alice García"), at)
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), later)
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Alice García")
  })
})

describe("RtcFeed local user resolution", () => {
  // The local user's own deviceId -> name is seeded into the roster (from the
  // UpdateMeetingDevice RPC) like any participant, so self resolves through the
  // roster — the feed has no separate self-name path.
  it("resolves the local user's lines via their roster entry", () => {
    const roster = new Map([[ALICE, "Grace Hopper"]])
    const feed = new RtcFeed(roster)
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Grace Hopper")
  })

  it("falls back to a stable per-device Speaker label when the roster has no entry", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Speaker 1")
  })

  it("does not collapse two unrostered speakers onto one label", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    feed.handleCaption(caption(BOB, 2, 1, "Hi"), at)
    const speakers = feed.transcriptSnapshot().map((u) => u.speaker)
    expect(new Set(speakers).size).toBe(2)
  })

  it("resolves retroactively once the local device's name is seeded into the roster", () => {
    const roster = new Map<string, string>()
    const feed = new RtcFeed(roster)
    feed.handleCaption(caption(ALICE, 1, 1, "Hello"), at)
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Speaker 1")
    roster.set(ALICE, "Grace Hopper")
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Grace Hopper")
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

describe("RtcFeed version history", () => {
  it("accumulates distinct versions per caption in order", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "Hel"), at)
    feed.handleCaption(caption(ALICE, 1, 2, "Hello"), later)
    feed.handleCaption(caption(ALICE, 1, 3, "Hello there"), later)
    expect(feed.versionsSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: at, versions: ["Hel", "Hello", "Hello there"] },
    ])
  })

  it("dedupes consecutive identical text even when the version bumps", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "Done"), at)
    feed.handleCaption(caption(ALICE, 1, 2, "Done"), later) // identical text, higher version
    feed.handleCaption(caption(ALICE, 1, 3, "Done."), later)
    expect(feed.versionsSnapshot()[0].versions).toEqual(["Done", "Done."])
  })

  it("keeps stale revisions out of the history", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 3, "Final"), at)
    feed.handleCaption(caption(ALICE, 1, 2, "Older"), later)
    expect(feed.versionsSnapshot()[0].versions).toEqual(["Final"])
  })

  it("keeps a single-version phrase as a one-element history", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "Hi"), at)
    expect(feed.versionsSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: at, versions: ["Hi"] },
    ])
  })

  it("resolves speaker names retroactively like the transcript", () => {
    const roster = new Map<string, string>()
    const feed = new RtcFeed(roster)
    feed.handleCaption(caption(ALICE, 1, 1, "Hi"), at)
    roster.set(ALICE, "Alice García")
    expect(feed.versionsSnapshot()[0].speaker).toBe("Alice García")
  })
})

describe("suffixAfter", () => {
  it("returns the whole text when there is no base prefix", () => {
    expect(suffixAfter("hello there", "")).toBe("hello there")
  })

  it("strips a clean word prefix", () => {
    expect(suffixAfter("a b c d", "a b")).toBe("c d")
  })

  it("ignores casing and punctuation churn when matching the prefix", () => {
    // Meet flips the first letter's case and churns punctuation between frames.
    expect(suffixAfter("I think we should go", "I think, we should")).toBe("go")
  })

  it("emits the remainder from the first divergence when the base was reworded (never drops the tail)", () => {
    // Meet rewrote an earlier word (should -> shall); rather than dropping words we
    // re-emit from the divergence point, duplicating at most a word at the seam.
    expect(suffixAfter("I think we shall go", "I think we should")).toBe("shall go")
  })

  it("trims surrounding whitespace", () => {
    expect(suffixAfter("  hi there  ", "")).toBe("hi there")
  })
})

describe("RtcFeed interruption split", () => {
  it("splits a resumed turn when another speaker interjected after a pause", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "I think we should"), t(0))
    feed.handleCaption(caption(BOB, 7, 1, "wait"), t(1000))
    feed.handleCaption(caption(ALICE, 1, 2, "I think we should go with option two"), t(3000))
    expect(feed.transcriptSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: t(0), endedAt: t(0), text: "I think we should" },
      { speaker: "Speaker 1", startedAt: t(3000), endedAt: t(3000), text: "go with option two" },
      { speaker: "Speaker 2", startedAt: t(1000), endedAt: t(1000), text: "wait" },
    ])
  })

  it("does not split fast crosstalk (another speaker but under the interruption gap)", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "one"), t(0))
    feed.handleCaption(caption(BOB, 7, 1, "two"), t(300))
    feed.handleCaption(caption(ALICE, 1, 2, "one three"), t(500))
    const alice = feed.transcriptSnapshot().filter((u) => u.speaker === "Speaker 1")
    expect(alice).toEqual([{ speaker: "Speaker 1", startedAt: t(0), endedAt: t(500), text: "one three" }])
  })

  it("does not split a solo pause, however long, when nobody else speaks", () => {
    // Only another speaker interrupting splits a turn. A solo pause never does:
    // Meet already starts a fresh messageId after a real pause, so there is
    // nothing to split, and splitting a lone messageId would only fragment it.
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "first thought"), t(0))
    feed.handleCaption(caption(ALICE, 1, 2, "first thought and then some"), t(6000))
    expect(feed.transcriptSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: t(0), endedAt: t(6000), text: "first thought and then some" },
    ])
  })

  it("keeps a long continuous monologue as a single block", () => {
    const feed = new RtcFeed()
    let version = 1
    let text = "w0"
    feed.handleCaption(caption(ALICE, 1, version, text), t(0))
    for (let ms = 2500; ms <= 62500; ms += 2500) {
      version += 1
      text += ` w${ms}`
      feed.handleCaption(caption(ALICE, 1, version, text), t(ms))
    }
    const result = feed.transcriptSnapshot()
    expect(result).toHaveLength(1)
    expect(result[0].startedAt).toBe(t(0))
    expect(result[0].text.endsWith("w62500")).toBe(true)
  })

  it("does not treat the same speaker's other message as an interruption", () => {
    // Two messageIds from the SAME device must not split each other, even across a
    // long gap: only ANOTHER device counts as an interruption.
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "first"), t(0))
    feed.handleCaption(caption(ALICE, 2, 1, "second"), t(2000))
    feed.handleCaption(caption(ALICE, 1, 2, "first extended"), t(3000))
    const msg1 = feed.transcriptSnapshot().filter((u) => u.startedAt === t(0))
    expect(msg1).toEqual([{ speaker: "Speaker 1", startedAt: t(0), endedAt: t(3000), text: "first extended" }])
  })

  it("carries a per-segment version history so alternatives stay attached after a split", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "hello wor"), t(0))
    feed.handleCaption(caption(ALICE, 1, 2, "hello world"), t(200))
    feed.handleCaption(caption(BOB, 2, 1, "hi"), t(1000))
    feed.handleCaption(caption(ALICE, 1, 3, "hello world and more"), t(3000))
    expect(feed.versionsSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: t(0), versions: ["hello wor", "hello world"] },
      { speaker: "Speaker 1", startedAt: t(3000), versions: ["and more"] },
      { speaker: "Speaker 2", startedAt: t(1000), versions: ["hi"] },
    ])
  })

  it("keeps the whole final text in one block when it is never interrupted", () => {
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "keep"), t(0))
    feed.handleCaption(caption(ALICE, 1, 2, "keep it whole"), t(800))
    expect(feed.transcriptSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: t(0), endedAt: t(800), text: "keep it whole" },
    ])
  })

  it("stamps endedAt at the last growth of the text, not a later no-growth flush", () => {
    // Meet re-sends a messageId's final text at meeting end without adding words;
    // endedAt must stay at the real spoken end, not jump to the flush time.
    const feed = new RtcFeed()
    feed.handleCaption(caption(ALICE, 1, 1, "hello"), t(0))
    feed.handleCaption(caption(ALICE, 1, 2, "hello world"), t(2000))
    feed.handleCaption(caption(ALICE, 1, 3, "hello world"), t(30000)) // flush, no growth
    expect(feed.transcriptSnapshot()).toEqual([
      { speaker: "Speaker 1", startedAt: t(0), endedAt: t(2000), text: "hello world" },
    ])
  })
})

describe("RtcFeed own-chat cross-transport dedup", () => {
  it("collapses the same self message captured on both transports", () => {
    // meet_messages hook ("self-out/…") and the chat frame ("self-topic/…") both
    // fire for one send; ChatLog cannot collapse them (distinct ids), the feed must.
    const feed = new RtcFeed()
    expect(feed.handleChat(chatWithId("self", "Hello team", "self-out/123"), t(0))).toBe(true)
    expect(feed.handleChat(chatWithId("self", "Hello team", "self-topic/456"), t(200))).toBe(false)
    expect(feed.chatSnapshot()).toHaveLength(1)
  })

  it("keeps a genuine re-send of the same text outside the window", () => {
    const feed = new RtcFeed()
    expect(feed.handleChat(chatWithId("self", "ok", "self-topic/1"), t(0))).toBe(true)
    expect(feed.handleChat(chatWithId("self", "ok", "self-topic/2"), t(6000))).toBe(true)
    expect(feed.chatSnapshot()).toHaveLength(2)
  })

  it("does not apply the self guard to others' chat with identical text", () => {
    const feed = new RtcFeed()
    expect(feed.handleChat(chatWithId(ALICE, "ok", "spaces/a/messages/1"), t(0))).toBe(true)
    expect(feed.handleChat(chatWithId(BOB, "ok", "spaces/a/messages/2"), t(200))).toBe(true)
    expect(feed.chatSnapshot()).toHaveLength(2)
  })
})

describe("RtcFeed.reset", () => {
  const AT = "2026-07-29T10:00:00.000Z"
  const AT2 = "2026-07-29T10:00:05.000Z"

  it("clears captured transcript, chat and versions but keeps the roster", () => {
    const roster = new Map<string, string>([["dev-1", "Grace Hopper"]])
    const feed = new RtcFeed(roster)

    feed.handleCaption(
      { type: "utterance", speakerId: "dev-1", utteranceId: "1", revision: 1, text: "hello world" },
      AT,
    )
    feed.handleChat({ type: "chat", speakerId: "dev-1", text: "hi in chat", sender: "Grace Hopper" }, AT)

    expect(feed.transcriptSnapshot().length).toBeGreaterThan(0)
    expect(feed.chatSnapshot().length).toBeGreaterThan(0)
    expect(feed.versionsSnapshot().length).toBeGreaterThan(0)

    feed.reset()

    expect(feed.transcriptSnapshot()).toEqual([])
    expect(feed.chatSnapshot()).toEqual([])
    expect(feed.versionsSnapshot()).toEqual([])

    // Roster retained: a fresh caption from the same device still resolves its name.
    feed.handleCaption(
      { type: "utterance", speakerId: "dev-1", utteranceId: "2", revision: 1, text: "after reset" },
      AT2,
    )
    const after = feed.transcriptSnapshot()
    expect(after).toHaveLength(1)
    expect(after[0].speaker).toBe("Grace Hopper")
    expect(after[0].text).toBe("after reset")
  })
})
