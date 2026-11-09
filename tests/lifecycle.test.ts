import { describe, expect, it } from "vitest"
import { isLivePrimary, makeChannelIdAllocator, makeStreamIds, shouldRecreateCaptions } from "../src/content/meet-rtc/lifecycle"

describe("makeChannelIdAllocator", () => {
  it("yields incrementing ids starting one past the seed", () => {
    const next = makeChannelIdAllocator()
    expect(next()).toBe(50001)
    expect(next()).toBe(50002)
    expect(next()).toBe(50003)
  })

  it("honours a custom start", () => {
    const next = makeChannelIdAllocator(100)
    expect(next()).toBe(101)
    expect(next()).toBe(102)
  })

  it("never repeats an id across many allocations", () => {
    const next = makeChannelIdAllocator()
    const ids = new Set<number>()
    for (let i = 0; i < 1000; i++) ids.add(next())
    expect(ids.size).toBe(1000)
  })
})

describe("shouldRecreateCaptions", () => {
  it("recreates only when the channel is gone and the pc can still host one", () => {
    expect(shouldRecreateCaptions("closed", "connected")).toBe(true)
    expect(shouldRecreateCaptions("closing", "connected")).toBe(true)
    expect(shouldRecreateCaptions("closed", "connecting")).toBe(true)
  })

  it("does not recreate while the channel is alive", () => {
    expect(shouldRecreateCaptions("open", "connected")).toBe(false)
    expect(shouldRecreateCaptions("connecting", "connected")).toBe(false)
  })

  it("does not recreate once the pc is gone for good", () => {
    expect(shouldRecreateCaptions("closed", "closed")).toBe(false)
    expect(shouldRecreateCaptions("closing", "failed")).toBe(false)
  })
})

describe("isLivePrimary", () => {
  it("is true for a subscribed session whose channel and pc are both alive", () => {
    expect(isLivePrimary({ subscribed: true, channelState: "open", pcState: "connected" })).toBe(true)
    expect(isLivePrimary({ subscribed: true, channelState: "open", pcState: "connecting" })).toBe(true)
    expect(isLivePrimary({ subscribed: true, channelState: "open", pcState: "new" })).toBe(true)
  })

  it("is false for a session that never subscribed", () => {
    expect(isLivePrimary({ subscribed: false, channelState: "open", pcState: "connected" })).toBe(false)
  })

  it("is false once the media-session channel is gone", () => {
    expect(isLivePrimary({ subscribed: true, channelState: "closing", pcState: "connected" })).toBe(false)
    expect(isLivePrimary({ subscribed: true, channelState: "closed", pcState: "connected" })).toBe(false)
  })

  it("is false once the pc can no longer carry captions", () => {
    expect(isLivePrimary({ subscribed: true, channelState: "open", pcState: "disconnected" })).toBe(false)
    expect(isLivePrimary({ subscribed: true, channelState: "open", pcState: "failed" })).toBe(false)
    expect(isLivePrimary({ subscribed: true, channelState: "open", pcState: "closed" })).toBe(false)
  })
})

describe("makeStreamIds", () => {
  // Meet gives the captions channel the same SCTP id on every peer connection
  // (125 on both connections while presenting, 2026-11-09), so the id cannot tell
  // two caption streams apart. The stream number belongs to the channel object.
  it("tells apart two channels that carry the same id", () => {
    const streamOf = makeStreamIds()
    const a = { id: 125 }
    const b = { id: 125 }
    expect(streamOf(a)).not.toBe(streamOf(b))
  })

  it("keeps one number for one channel", () => {
    const streamOf = makeStreamIds()
    const a = { id: 125 }
    const first = streamOf(a)
    streamOf({ id: 4 })
    expect(streamOf(a)).toBe(first)
  })

  it("never hands out 0, the number of a caption without a stream", () => {
    const streamOf = makeStreamIds()
    expect(streamOf({})).toBeGreaterThan(0)
  })
})
