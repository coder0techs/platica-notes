import { describe, expect, it } from "vitest"
import { isCaptionsLabel, isUsableCaption, carriesCaptions } from "../src/content/meet-rtc/channels"
import type { Transcript } from "../src/content/meet-rtc/proto"

const caption = (over: Partial<Transcript> = {}): Transcript => ({
  deviceId: "spaces/TestSpace01/devices/74",
  messageId: 3,
  messageVersion: 16,
  text: "Hello world",
  ...over,
})

describe("isCaptionsLabel", () => {
  it("matches the channel Meet has always used", () => {
    expect(isCaptionsLabel("captions")).toBe(true)
  })

  it("matches a versioned rename, which is how the last one arrived", () => {
    expect(isCaptionsLabel("captions_v2")).toBe(true)
    expect(isCaptionsLabel("captions_v3")).toBe(true)
    expect(isCaptionsLabel("captions_v10")).toBe(true)
  })

  it("does not match the other channels in a Meet call", () => {
    for (const label of ["collections", "media-session", "audioprocessor", "meet_messages", "dcrpc", "s11y-sync"]) {
      expect(isCaptionsLabel(label), label).toBe(false)
    }
  })

  it("does not match a label that merely contains the word", () => {
    for (const label of ["captions_v2x", "xcaptions", "mycaptions", "captions-v2", "captions_", ""]) {
      expect(isCaptionsLabel(label), label).toBe(false)
    }
  })
})

describe("isUsableCaption", () => {
  it("accepts a caption with every field the feed needs", () => {
    expect(isUsableCaption(caption())).toBe(true)
  })

  it("rejects one missing any of them", () => {
    expect(isUsableCaption(caption({ text: undefined }))).toBe(false)
    expect(isUsableCaption(caption({ text: "" }))).toBe(false)
    expect(isUsableCaption(caption({ deviceId: undefined }))).toBe(false)
    expect(isUsableCaption(caption({ messageId: undefined }))).toBe(false)
    expect(isUsableCaption(caption({ messageVersion: undefined }))).toBe(false)
  })

  it("accepts version zero, which is a real first revision and not a missing field", () => {
    expect(isUsableCaption(caption({ messageId: 0, messageVersion: 0 }))).toBe(true)
  })
})

describe("carriesCaptions", () => {
  it("recognises a frame that decoded into a real caption", () => {
    expect(carriesCaptions([caption()])).toBe(true)
  })

  it("says no to a frame that decoded into nothing", () => {
    expect(carriesCaptions([])).toBe(false)
  })

  it("says no when the speaker id is not a Meet device path", () => {
    // Guards adoption of an unrelated channel whose bytes happen to parse: the
    // cost of a false positive here is transcript lines invented out of another
    // channel's traffic.
    expect(carriesCaptions([caption({ deviceId: "dev-abc" })])).toBe(false)
    expect(carriesCaptions([caption({ deviceId: "spaces/TestSpace01" })])).toBe(false)
  })

  it("says no when nothing in the batch is usable", () => {
    expect(carriesCaptions([caption({ text: "" }), caption({ messageVersion: undefined })])).toBe(false)
  })

  it("says yes when one entry of a batch is a real caption", () => {
    expect(carriesCaptions([caption({ text: "" }), caption()])).toBe(true)
  })
})
