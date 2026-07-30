// Conformance tests for the capture contract (src/content/capture/protocol.ts).
//
// The point of these is that they drive the SHARED feed through a deliberately
// un-Meet-like platform profile: opaque string speaker ids, a fresh utterance id per
// turn (no interruption split) and a single own-chat transport. If the core ever
// grows a hidden Meet assumption, these fail while the Meet suite still passes.

import { describe, expect, it } from "vitest"
import { CaptureFeed } from "../src/content/core/feed"
import type { CaptionRules } from "../src/content/core/feed"
import type { PlatformAdapter } from "../src/content/platforms/adapter"

const FAKE_RULES: CaptionRules = {
  interruptionGapMs: null,
  speakerLabel: (id) => `Speaker ${id}`,
  selfChatDedupMs: null,
}

// A minimal second platform. It exists to prove the contract is satisfiable without
// any Meet-shaped behaviour: no liveness signal, no chat, no language control.
const fake: PlatformAdapter = {
  id: "zoom",
  capabilities: {
    chat: false,
    languageSwitch: "none",
    rawVersions: true,
    participantEvents: true,
    livenessEnd: false,
  },
  captionRules: FAKE_RULES,
  // No trailing captions after the call ends on this platform, so no flush window.
  timings: { captionFlushMs: 0, joinSettleMs: 10_000 },
  isMeetingPage: () => true,
  meetingKey: () => "123456789",
  waitForJoin: async () => true,
  watchEnd: () => () => {},
  readTitle: () => "Weekly sync",
  meetingUrl: (key) => `https://example.zoom.us/wc/${key}/join`,
  subscribe: () => () => {},
}

const at = (s: number): string => new Date(Date.UTC(2026, 6, 30, 9, 0, s)).toISOString()

describe("capture protocol conformance", () => {
  it("describes a platform with no liveness signal and no chat", () => {
    expect(fake.capabilities.livenessEnd).toBe(false)
    expect(fake.capabilities.chat).toBe(false)
    // No setLanguage at all, which is what languageSwitch "none" has to mean.
    expect(fake.setLanguage).toBeUndefined()
    expect(fake.meetingUrl(fake.meetingKey() as string)).toBe("https://example.zoom.us/wc/123456789/join")
  })

  it("accepts a growing utterance and keeps only the newest revision", () => {
    const feed = new CaptureFeed(new Map([["u1", "Grace Hopper"]]), fake.captionRules)
    expect(
      feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 1, text: "the compiler" }, at(0)),
    ).toBe(true)
    expect(
      feed.handleCaption(
        { type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 2, text: "the compiler works" },
        at(1),
      ),
    ).toBe(true)
    const turns = feed.transcriptSnapshot()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ speaker: "Grace Hopper", text: "the compiler works" })
  })

  it("rejects a stale or repeated revision instead of overwriting the text", () => {
    const feed = new CaptureFeed(new Map(), fake.captionRules)
    feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 7, text: "final text" }, at(0))
    expect(
      feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 7, text: "older" }, at(1)),
    ).toBe(false)
    expect(
      feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 6, text: "much older" }, at(2)),
    ).toBe(false)
    expect(feed.transcriptSnapshot()[0].text).toBe("final text")
  })

  it("treats the same utterance id from two speakers as two turns", () => {
    const feed = new CaptureFeed(new Map(), fake.captionRules)
    feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "1", revision: 1, text: "mine" }, at(0))
    feed.handleCaption({ type: "utterance", speakerId: "u2", utteranceId: "1", revision: 1, text: "also mine" }, at(1))
    expect(feed.transcriptSnapshot().map((u) => u.text)).toEqual(["mine", "also mine"])
  })

  it("labels an unknown speaker through the platform's rule", () => {
    const feed = new CaptureFeed(new Map(), fake.captionRules)
    feed.handleCaption({ type: "utterance", speakerId: "77", utteranceId: "1", revision: 1, text: "hi" }, at(0))
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Speaker 77")
  })

  it("keeps every distinct revision for the alternatives feature", () => {
    const feed = new CaptureFeed(new Map(), fake.captionRules)
    for (const [i, text] of ["a", "a b", "a b c"].entries()) {
      feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: i + 1, text }, at(i))
    }
    expect(feed.versionsSnapshot()[0].versions).toEqual(["a", "a b", "a b c"])
  })
})
