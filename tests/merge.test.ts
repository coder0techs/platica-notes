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
    // A stored meeting with nothing captured is a failure row and never a merge
    // target, so the mergeable default carries one turn.
    transcript: [{ speaker: "A", startedAt: "2026-06-30T10:01:00.000Z", text: "hi" }],
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
  it("extracts the code from the /meet/ url shape", () => {
    expect(meetCodeFromUrl("https://meet.google.com/meet/abc-defg-hij")).toBe("abc-defg-hij")
    expect(meetCodeFromUrl("https://meet.google.com/meet/ABC-DEFG-HIJ?authuser=0")).toBe("abc-defg-hij")
  })
  it("returns null for a non-meeting url and for undefined", () => {
    expect(meetCodeFromUrl("https://meet.google.com/lookup/xyz")).toBeNull()
    expect(meetCodeFromUrl("https://meet.google.com/meet/")).toBeNull()
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
  it("merges just inside the ~40-minute window but not just past it", () => {
    // target ended 10:30. The default window is ~40 min.
    expect(shouldMerge(target, meeting({ id: "m2", startedAt: "2026-06-30T11:05:00.000Z" }), MERGE_GAP_MS)).toBe(true) // +35 min
    expect(shouldMerge(target, meeting({ id: "m2", startedAt: "2026-06-30T11:15:00.000Z" }), MERGE_GAP_MS)).toBe(false) // +45 min
  })
  it("merges across midnight when inside the gap (no calendar-day rule)", () => {
    const lateTarget = meeting({ startedAt: "2026-06-30T23:40:00.000Z", endedAt: "2026-06-30T23:55:00.000Z" })
    const incoming = meeting({ id: "m2", startedAt: "2026-07-01T00:05:00.000Z", endedAt: "2026-07-01T00:20:00.000Z" })
    expect(shouldMerge(lateTarget, incoming, MERGE_GAP_MS)).toBe(true)
  })
  it("merges a rejoin at the /meet/ url, and across the two url shapes", () => {
    const meetTarget = meeting({ endedAt: "2026-06-30T10:30:00.000Z", meetingUrl: "https://meet.google.com/meet/abc-defg-hij" })
    const rejoin = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", meetingUrl: "https://meet.google.com/meet/abc-defg-hij" })
    expect(shouldMerge(meetTarget, rejoin, MERGE_GAP_MS)).toBe(true)
    const rootRejoin = meeting({ id: "m3", startedAt: "2026-06-30T10:35:00.000Z" })
    expect(shouldMerge(meetTarget, rootRejoin, MERGE_GAP_MS)).toBe(true)
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

  it("concatenates participant events across visits", () => {
    const t = meeting({ participantEvents: [{ at: "2026-06-30T10:10:00.000Z", name: "Grace", kind: "join" }] })
    const i = meeting({ id: "m2", participantEvents: [{ at: "2026-06-30T10:40:00.000Z", name: "Linus", kind: "join" }] })
    const m = mergeMeetings(t, i)
    expect(m.participantEvents).toEqual([
      { at: "2026-06-30T10:10:00.000Z", name: "Grace", kind: "join" },
      { at: "2026-06-30T10:40:00.000Z", name: "Linus", kind: "join" },
    ])
  })
})

describe("mergeMeetings — diagnostics", () => {
  it("concatenates the lite log of both visits so the rejoin's diagnostics are not lost", () => {
    const a = meeting({ lite: [{ t: "2026-06-30T10:01:00.000Z", ctx: "rtc", phase: "channel" }] })
    const b = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z",
      lite: [{ t: "2026-06-30T10:36:00.000Z", ctx: "rtc", phase: "funnel" }] })
    expect(mergeMeetings(a, b).lite?.map((e) => e.phase)).toEqual(["channel", "funnel"])
  })

  it("keeps the incoming language when the target had none", () => {
    const a = meeting({})
    const b = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z", language: "es-MX" })
    expect(mergeMeetings(a, b).language).toBe("es-MX")
    expect(mergeMeetings(meeting({ language: "en-US" }), b).language).toBe("en-US")
  })
})

describe("shouldMerge — capture failure", () => {
  it("never folds a rejoin into a visit that captured nothing, so the failure row stays visible", () => {
    const failed = meeting({ transcript: [], participants: ["Ada", "Grace"] }) // nothing captured
    const rejoin = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z",
      transcript: [{ speaker: "A", startedAt: "2026-06-30T10:40:00.000Z", text: "hi" }] })
    expect(shouldMerge(failed, rejoin, MERGE_GAP_MS)).toBe(false)
  })
})
