import { describe, expect, it } from "vitest"
import { appendWithRetention, enqueue } from "../src/background/store"
import type { Meeting } from "../src/shared/types"

function makeMeeting(id: string): Meeting {
  return {
    id, platform: "meet", title: id,
    startedAt: "2026-06-10T10:00:00.000Z", endedAt: "2026-06-10T10:30:00.000Z",
    isPrivate: false, transcript: [], chat: [],
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
