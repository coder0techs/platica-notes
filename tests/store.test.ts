import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeChromeMock, type ChromeMock } from "./helpers/chrome-mock"
import { appendWithRetention, commitFinalizedMeeting, enqueue, listMeetings } from "../src/background/store"
import type { Meeting } from "../src/shared/types"

function makeMeeting(id: string): Meeting {
  return {
    id, platform: "meet", title: id,
    startedAt: "2026-06-10T10:00:00.000Z", endedAt: "2026-06-10T10:30:00.000Z",
    isPrivate: false, transcript: [], chat: [], participants: [],
  }
}

describe("appendWithRetention", () => {
  it("appends below the limit", () => {
    const result = appendWithRetention([makeMeeting("a")], makeMeeting("b"), 30)
    expect(result.map(m => m.id)).toEqual(["a", "b"])
  })

  it("drops the oldest entries above the limit", () => {
    const existing = [makeMeeting("a"), makeMeeting("b"), makeMeeting("c")]
    const result = appendWithRetention(existing, makeMeeting("d"), 3)
    expect(result.map(m => m.id)).toEqual(["b", "c", "d"])
  })
})

describe("enqueue", () => {
  it("runs operations strictly in order", async () => {
    const order: number[] = []
    const slow = enqueue(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push(1)
    })
    const fast = enqueue(async () => { order.push(2) })
    await Promise.all([slow, fast])
    expect(order).toEqual([1, 2])
  })

  it("keeps the queue alive after a failure", async () => {
    await expect(enqueue(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await expect(enqueue(async () => "ok")).resolves.toBe("ok")
  })
})

function meetMeeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1", platform: "meet", title: "Daily",
    startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:30:00.000Z",
    isPrivate: false, transcript: [], chat: [], participants: [],
    meetingUrl: "https://meet.google.com/abc-defg-hij", ...over,
  }
}

describe("commitFinalizedMeeting", () => {
  let chrome: ChromeMock
  beforeEach(() => {
    chrome = makeChromeMock()
    ;(globalThis as unknown as { chrome: ChromeMock }).chrome = chrome
  })
  afterEach(() => { delete (globalThis as unknown as { chrome?: ChromeMock }).chrome })

  it("appends a fresh meeting when nothing matches", async () => {
    const { meeting, merged } = await commitFinalizedMeeting(meetMeeting(), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    expect(merged).toBe(false)
    expect(meeting.id).toBe("m1")
    expect(await listMeetings()).toHaveLength(1)
  })

  it("merges a sequential same-code visit in place (one entry, visits=2)", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    const { meeting, merged } = await commitFinalizedMeeting(
      meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    expect(merged).toBe(true)
    expect(meeting.id).toBe("m1") // target identity preserved
    const all = await listMeetings()
    expect(all).toHaveLength(1)
    expect(all[0].visits).toHaveLength(2)
  })

  it("does not merge when mergeEnabled is false", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: false, gapMs: 7_200_000 }, 30)
    await commitFinalizedMeeting(meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z" }), { mergeEnabled: false, gapMs: 7_200_000 }, 30)
    expect(await listMeetings()).toHaveLength(2)
  })

  it("does not merge a different code", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    await commitFinalizedMeeting(
      meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    expect(await listMeetings()).toHaveLength(2)
  })

  it("merges into the most recent same-code visit even when another meeting is interleaved", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    await commitFinalizedMeeting(
      meetMeeting({ id: "other", startedAt: "2026-06-30T10:31:00.000Z", endedAt: "2026-06-30T10:32:00.000Z", meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    const { merged } = await commitFinalizedMeeting(
      meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    expect(merged).toBe(true)
    const all = await listMeetings()
    expect(all).toHaveLength(2) // m1(+m2) and "other"
    expect(all.find(m => m.id === "m1")!.visits).toHaveLength(2)
  })
})
