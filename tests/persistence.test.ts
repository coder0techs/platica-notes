import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionWriter } from "../src/content/core/persistence"

describe("SessionWriter", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function makeWriter(writes: number[]) {
    let counter = 0
    return new SessionWriter<number>(
      async (snapshot) => { writes.push(snapshot) },
      () => ++counter,
      1000,
    )
  }

  it("writes immediately on the first request", () => {
    const writes: number[] = []
    makeWriter(writes).requestWrite()
    expect(writes).toEqual([1])
  })

  it("coalesces a burst into a single trailing write", async () => {
    const writes: number[] = []
    const writer = makeWriter(writes)
    writer.requestWrite()
    writer.requestWrite()
    writer.requestWrite()
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(2)
  })

  it("does not write trailing when no extra requests arrived", async () => {
    const writes: number[] = []
    makeWriter(writes).requestWrite()
    await vi.advanceTimersByTimeAsync(5000)
    expect(writes).toHaveLength(1)
  })

  it("writeNow persists the current snapshot immediately", async () => {
    const writes: number[] = []
    await makeWriter(writes).writeNow()
    expect(writes).toEqual([1])
  })
})
