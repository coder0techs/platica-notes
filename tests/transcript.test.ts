import { describe, expect, it } from "vitest"
import { flattenTimeline, isNearBottom, mergeTimeline, mergeUtterances } from "../src/shared/transcript"
import type { ChatMessage, Note, Utterance } from "../src/shared/types"

const u = (speaker: string, startedAt: string, text: string): Utterance => ({ speaker, startedAt, text })
const cm = (sender: string, sentAt: string, text: string): ChatMessage => ({ sender, sentAt, text })
const nt = (at: string, text: string): Note => ({ at, text })

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
    expect(out[1]).toEqual({
      kind: "chat",
      speaker: "Alice",
      text: "(see chat)",
      at: "2026-06-10T10:01:30.000Z",
      endAt: "2026-06-10T10:01:30.000Z",
    })
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
        u("Alice", "2026-06-10T10:01:02.000Z", "two"),
      ],
      [],
    )
    expect(out).toEqual([
      { kind: "speech", speaker: "Alice", text: "one two", at: "2026-06-10T10:01:00.000Z", endAt: "2026-06-10T10:01:02.000Z" },
    ])
  })

  it("breaks a same-speaker run when the pause exceeds the paragraph gap", () => {
    // A long silence between two utterances of the same speaker is a new paragraph,
    // not a continuation — the panel must show the break the way the saved file does.
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "before the pause"),
        u("Alice", "2026-06-10T10:01:13.000Z", "after a long pause"),
      ],
      [],
    )
    expect(out.map((e) => [e.speaker, e.text])).toEqual([
      ["Alice", "before the pause"],
      ["Alice", "after a long pause"],
    ])
  })

  it("keeps a same-speaker run merged when the pause is under the paragraph gap", () => {
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "still"),
        u("Alice", "2026-06-10T10:01:02.000Z", "talking"),
      ],
      [],
    )
    expect(out).toEqual([
      { kind: "speech", speaker: "Alice", text: "still talking", at: "2026-06-10T10:01:00.000Z", endAt: "2026-06-10T10:01:02.000Z" },
    ])
  })

  it("merges a long continuous phrase with the next turn when the pause after its END is short", () => {
    // Meet chops continuous speech into back-to-back phrase messageIds: phrase 1
    // spans 20s, phrase 2 starts 1s after it ENDED. Measured end->start the pause is
    // 1s, so they stay one paragraph despite starts being 21s apart.
    const out = mergeTimeline(
      [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", endedAt: "2026-06-10T10:01:20.000Z", text: "a long continuous phrase" },
        { speaker: "Alice", startedAt: "2026-06-10T10:01:21.000Z", endedAt: "2026-06-10T10:01:25.000Z", text: "kept going" },
      ],
      [],
    )
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("a long continuous phrase kept going")
  })

  it("breaks when the silence after the previous utterance's END exceeds the gap", () => {
    const out = mergeTimeline(
      [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", endedAt: "2026-06-10T10:01:05.000Z", text: "before" },
        { speaker: "Alice", startedAt: "2026-06-10T10:01:20.000Z", endedAt: "2026-06-10T10:01:22.000Z", text: "after" },
      ],
      [],
    )
    expect(out.map((e) => e.text)).toEqual(["before", "after"])
  })

  it("measures the pause from the last merged piece, not the block start", () => {
    // Three pieces 3s apart span 6s in total but never pause longer than the gap,
    // so they stay one block: the break is about a real silence, not block length.
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "a"),
        u("Alice", "2026-06-10T10:01:03.000Z", "b"),
        u("Alice", "2026-06-10T10:01:06.000Z", "c"),
      ],
      [],
    )
    expect(out).toEqual([
      { kind: "speech", speaker: "Alice", text: "a b c", at: "2026-06-10T10:01:00.000Z", endAt: "2026-06-10T10:01:06.000Z" },
    ])
  })

  it("returns only chat when there is no transcript", () => {
    const out = mergeTimeline([], [cm("Bob", "2026-06-10T10:00:00.000Z", "hello")])
    expect(out).toEqual([
      { kind: "chat", speaker: "Bob", text: "hello", at: "2026-06-10T10:00:00.000Z", endAt: "2026-06-10T10:00:00.000Z" },
    ])
  })

  it("returns an empty array when both inputs are empty", () => {
    expect(mergeTimeline([], [])).toEqual([])
  })
})

describe("flattenTimeline", () => {
  it("does NOT merge consecutive same-speaker speech (one entry per utterance)", () => {
    const out = flattenTimeline(
      [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "one" },
        { speaker: "Alice", startedAt: "2026-06-10T10:01:05.000Z", text: "two" },
      ],
      [],
    )
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.text)).toEqual(["one", "two"])
  })

  it("interleaves chat into speech in time order", () => {
    const out = flattenTimeline(
      [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "speak" }],
      [{ sender: "Bob", sentAt: "2026-06-10T10:00:30.000Z", text: "early chat" }],
    )
    expect(out.map((e) => e.text)).toEqual(["early chat", "speak"])
    expect(out[0].kind).toBe("chat")
  })

  it("at an identical instant, speech sorts before chat", () => {
    const at = "2026-06-10T10:01:00.000Z"
    const out = flattenTimeline(
      [{ speaker: "Alice", startedAt: at, text: "spoke" }],
      [{ sender: "Bob", sentAt: at, text: "typed" }],
    )
    expect(out.map((e) => e.kind)).toEqual(["speech", "chat"])
  })

  it("trims utterance text", () => {
    const out = flattenTimeline([{ speaker: "A", startedAt: "2026-06-10T10:01:00.000Z", text: "  hi  " }], [])
    expect(out[0].text).toBe("hi")
  })

  it("interleaves notes by time, tagged kind 'note' with an empty speaker", () => {
    const out = flattenTimeline(
      [u("Alice", "2026-06-10T10:01:00.000Z", "speak")],
      [],
      [nt("2026-06-10T10:00:30.000Z", "remember this")],
    )
    expect(out.map((e) => [e.kind, e.text])).toEqual([
      ["note", "remember this"],
      ["speech", "speak"],
    ])
    expect(out[0].speaker).toBe("")
  })

  it("keeps a bare bookmark (empty text) as a note entry", () => {
    const out = flattenTimeline([], [], [nt("2026-06-10T10:00:30.000Z", "")])
    expect(out).toEqual([
      { kind: "note", speaker: "", text: "", at: "2026-06-10T10:00:30.000Z", endAt: "2026-06-10T10:00:30.000Z" },
    ])
  })

  it("at an identical instant, orders speech, then chat, then note", () => {
    const at = "2026-06-10T10:01:00.000Z"
    const out = flattenTimeline(
      [u("A", at, "spoke")],
      [cm("B", at, "typed")],
      [nt(at, "noted")],
    )
    expect(out.map((e) => e.kind)).toEqual(["speech", "chat", "note"])
  })
})

describe("interruption-split interaction", () => {
  // feed.ts splits an interrupted speaker's turn into two utterances, each with its
  // own startedAt (A1 at the start, A2 at the resume time). These tests pin the
  // downstream contract: the time sort keeps them in true chronological order and
  // the interrupter is NOT re-merged away.
  it("keeps an interrupted-then-resumed speaker in chronological order (flatten)", () => {
    const out = flattenTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "I think we should"),
        u("Alice", "2026-06-10T10:01:03.000Z", "go with option two"),
        u("Bob", "2026-06-10T10:01:01.000Z", "wait"),
      ],
      [],
    )
    expect(out.map((e) => [e.speaker, e.text])).toEqual([
      ["Alice", "I think we should"],
      ["Bob", "wait"],
      ["Alice", "go with option two"],
    ])
  })

  it("does not re-merge two of a speaker's segments across the interrupter (mergeTimeline)", () => {
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "I think we should"),
        u("Alice", "2026-06-10T10:01:03.000Z", "go with option two"),
        u("Bob", "2026-06-10T10:01:01.000Z", "wait"),
      ],
      [],
    )
    expect(out.map((e) => e.speaker)).toEqual(["Alice", "Bob", "Alice"])
  })

  it("breaks a long monologue's segments into separate paragraphs (the pause between them is real)", () => {
    // A 60s gap is well past the paragraph threshold, so the two segments render as
    // two blocks — the panel now surfaces the pause instead of gluing them.
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "part one"),
        u("Alice", "2026-06-10T10:02:00.000Z", "part two"),
      ],
      [],
    )
    expect(out.map((e) => e.text)).toEqual(["part one", "part two"])
  })
})

describe("mergeTimeline with notes", () => {
  it("never folds a note into a speech run — a note splits same-speaker speech", () => {
    const out = mergeTimeline(
      [
        u("Alice", "2026-06-10T10:01:00.000Z", "one"),
        u("Alice", "2026-06-10T10:01:10.000Z", "two"),
      ],
      [],
      [nt("2026-06-10T10:01:05.000Z", "mark")],
    )
    expect(out.map((e) => [e.kind, e.text])).toEqual([
      ["speech", "one"],
      ["note", "mark"],
      ["speech", "two"],
    ])
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

describe("timeline with participant events", () => {
  const pe = (at: string, name: string, kind: "join" | "leave" = "join") => ({ at, name, kind })

  it("flattenTimeline includes a join as its own entry (empty text, at === endAt)", () => {
    const out = flattenTimeline([], [], [], [pe("2026-06-10T10:05:00.000Z", "Grace Hopper")])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: "join",
      speaker: "Grace Hopper",
      text: "",
      at: "2026-06-10T10:05:00.000Z",
      endAt: "2026-06-10T10:05:00.000Z",
    })
  })

  it("places a join at its chronological position among speech and chat", () => {
    const out = flattenTimeline(
      [u("Alice", "2026-06-10T10:00:00.000Z", "hi"), u("Bob", "2026-06-10T10:10:00.000Z", "bye")],
      [cm("Alice", "2026-06-10T10:06:00.000Z", "brb")],
      [],
      [pe("2026-06-10T10:05:00.000Z", "Grace Hopper")],
    )
    expect(out.map((e) => e.kind)).toEqual(["speech", "join", "chat", "speech"])
  })

  it("sorts a join before speech at the same instant (tie-break)", () => {
    const at = "2026-06-10T10:05:00.000Z"
    const out = flattenTimeline([u("Alice", at, "hi")], [], [], [pe(at, "Grace Hopper")])
    expect(out.map((e) => e.kind)).toEqual(["join", "speech"])
  })

  it("mergeTimeline: a join breaks a same-speaker run where it happened", () => {
    const out = mergeTimeline(
      [u("Alice", "2026-06-10T10:00:00.000Z", "first"), u("Alice", "2026-06-10T10:00:02.000Z", "second")],
      [],
      [],
      [pe("2026-06-10T10:00:01.000Z", "Grace Hopper")],
    )
    expect(out.map((e) => e.kind)).toEqual(["speech", "join", "speech"])
    expect(out[0].text).toBe("first")
    expect(out[2].text).toBe("second")
  })

  it("renders a reserved leave entry too", () => {
    const out = flattenTimeline([], [], [], [pe("2026-06-10T10:05:00.000Z", "Grace Hopper", "leave")])
    expect(out[0]).toMatchObject({ kind: "leave", speaker: "Grace Hopper" })
  })
})
