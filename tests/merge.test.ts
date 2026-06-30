import { describe, expect, it } from "vitest"
import { MERGE_GAP_MS, meetCodeFromUrl, mergeMeetings, shouldMerge } from "../src/background/merge"
import type { Meeting } from "../src/shared/types"

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    platform: "meet",
    title: "Daily",
    startedAt: "2026-06-30T10:00:00.000Z",
    endedAt: "2026-06-30T10:30:00.000Z",
    isPrivate: false,
    transcript: [],
    chat: [],
    participants: [],
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    ...over,
  }
}

describe("meetCodeFromUrl", () => {
  it("extracts the code from a join url", () => {
    expect(meetCodeFromUrl("https://meet.google.com/abc-defg-hij")).toBe("abc-defg-hij")
  })
  it("extracts the code ignoring trailing path/query", () => {
    expect(meetCodeFromUrl("https://meet.google.com/abc-defg-hij?authuser=0")).toBe("abc-defg-hij")
  })
  it("returns null for a non-meeting url and for undefined", () => {
    expect(meetCodeFromUrl("https://meet.google.com/lookup/xyz")).toBeNull()
    expect(meetCodeFromUrl(undefined)).toBeNull()
  })
})

describe("shouldMerge", () => {
  const target = meeting({ endedAt: "2026-06-30T10:30:00.000Z" })

  it("merges a sequential same-code visit inside the gap", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" })
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(true)
  })
  it("does not merge past the gap window", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T13:00:00.000Z" }) // +2.5 h
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("merges across midnight when inside the gap (no calendar-day rule)", () => {
    const lateTarget = meeting({ startedAt: "2026-06-30T23:40:00.000Z", endedAt: "2026-06-30T23:55:00.000Z" })
    const incoming = meeting({ id: "m2", startedAt: "2026-07-01T00:05:00.000Z", endedAt: "2026-07-01T00:20:00.000Z" })
    expect(shouldMerge(lateTarget, incoming, MERGE_GAP_MS)).toBe(true)
  })
  it("does not merge a different code", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" })
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("does not merge across differing privacy (privacy invariant)", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", isPrivate: true })
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("does not merge an overlapping (concurrent) visit", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:20:00.000Z" }) // before target ended
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("does not merge when a url is missing or platform is not meet", () => {
    expect(shouldMerge(meeting({ meetingUrl: undefined }), meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z" }), MERGE_GAP_MS)).toBe(false)
    expect(shouldMerge(target, meeting({ id: "m2", platform: "zoom", startedAt: "2026-06-30T10:35:00.000Z" }), MERGE_GAP_MS)).toBe(false)
  })
})

describe("mergeMeetings", () => {
  const target = meeting({
    id: "m1",
    startedAt: "2026-06-30T10:00:00.000Z",
    endedAt: "2026-06-30T10:30:00.000Z",
    transcript: [{ speaker: "A", startedAt: "2026-06-30T10:05:00.000Z", text: "one" }],
    participants: ["Ada", "Grace"],
  })
  const incoming = meeting({
    id: "m2",
    startedAt: "2026-06-30T10:35:00.000Z",
    endedAt: "2026-06-30T11:00:00.000Z",
    transcript: [{ speaker: "B", startedAt: "2026-06-30T10:40:00.000Z", text: "two" }],
    participants: ["Grace", "Linus"],
  })

  it("keeps target identity, extends endedAt, concatenates body, unions participants", () => {
    const m = mergeMeetings(target, incoming)
    expect(m.id).toBe("m1")
    expect(m.startedAt).toBe("2026-06-30T10:00:00.000Z")
    expect(m.endedAt).toBe("2026-06-30T11:00:00.000Z")
    expect(m.transcript.map(u => u.text)).toEqual(["one", "two"])
    expect(m.participants).toEqual(["Ada", "Grace", "Linus"])
  })

  it("synthesizes both visit spans on the first merge", () => {
    const m = mergeMeetings(target, incoming)
    expect(m.visits).toEqual([
      { startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:30:00.000Z" },
      { startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" },
    ])
  })

  it("appends a third visit incrementally", () => {
    const merged = mergeMeetings(target, incoming)
    const third = meeting({ id: "m3", startedAt: "2026-06-30T11:10:00.000Z", endedAt: "2026-06-30T11:20:00.000Z" })
    const m = mergeMeetings(merged, third)
    expect(m.visits).toHaveLength(3)
    expect(m.endedAt).toBe("2026-06-30T11:20:00.000Z")
  })
})
