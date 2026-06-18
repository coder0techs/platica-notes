import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionWriter } from "../src/content/core/persistence"

describe("SessionWriter", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function makeWriter(writes: number[]) {
    let counter = 0
    return new SessionWriter<number>(
      async (snapshot) => {
        writes.push(snapshot)
      },
      () => ++counter,
      1000,
    )
  }

  it("leading write happens on first request (after flush)", async () => {
    const writes: number[] = []
    makeWriter(writes).requestWrite()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([1])
  })

  it("coalesces a burst into a single trailing write after the interval", async () => {
    const writes: number[] = []
    const writer = makeWriter(writes)
    writer.requestWrite()
    writer.requestWrite()
    writer.requestWrite()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(2)
  })

  it("no trailing write when no extra requests arrived", async () => {
    const writes: number[] = []
    makeWriter(writes).requestWrite()
    await vi.advanceTimersByTimeAsync(5000)
    expect(writes).toHaveLength(1)
  })

  it("writeNow persists the current snapshot", async () => {
    const writes: number[] = []
    await makeWriter(writes).writeNow()
    expect(writes).toEqual([1])
  })

  it("rejecting write fn does not produce an unhandled rejection and chain survives", async () => {
    const writes: number[] = []
    let writeCallCount = 0
    let snapshotCounter = 0
    const writer = new SessionWriter<number>(
      async (snapshot) => {
        writeCallCount++
        if (writeCallCount === 1) throw new Error("disk full")
        writes.push(snapshot)
      },
      () => ++snapshotCounter,
      1000,
    )

    // First write — will reject
    writer.requestWrite()
    await vi.advanceTimersByTimeAsync(0)

    // Second write — must still go through despite the first rejection
    await writer.writeNow()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe(2) // snapshot taken on second enqueue
  })

  it("ordering: writeNow called during a slow in-flight write still lands after it", async () => {
    const writes: number[] = []
    let counter = 0
    let resolveFirst!: () => void

    const writer = new SessionWriter<number>(
      (snapshot) =>
        new Promise<void>((resolve) => {
          writes.push(snapshot)
          if (writes.length === 1) {
            resolveFirst = resolve
          } else {
            resolve()
          }
        }),
      () => ++counter,
      1000,
    )

    // Kick off first write — stalls until resolveFirst() is called
    writer.requestWrite()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveLength(1)

    // writeNow should queue behind the stalled write
    const finalWrite = writer.writeNow()

    // Unblock the first write
    resolveFirst()
    await finalWrite

    // Second write must come after first; last element must be from writeNow's snapshot
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(writes.length) // writeNow captured snapshot at call-time execution, which is after counter incremented twice
    expect(writes[1]).toBeGreaterThan(writes[0])
  })

  it("close() makes subsequent requestWrite a no-op (no session-key resurrection)", async () => {
    const writes: number[] = []
    const writer = makeWriter(writes)
    await writer.writeNow()
    const countAfterWriteNow = writes.length
    writer.close()

    writer.requestWrite() // a late/stray request after teardown
    await vi.advanceTimersByTimeAsync(5000)
    expect(writes).toHaveLength(countAfterWriteNow) // nothing more was written
  })

  it("writeNow cancels an armed trailing write so no extra write fires after", async () => {
    const writes: number[] = []
    const writer = makeWriter(writes)
    writer.requestWrite()
    writer.requestWrite() // arms trailing timer
    await vi.advanceTimersByTimeAsync(0) // flush leading write

    await writer.writeNow() // should cancel trailing timer
    const countAfterWriteNow = writes.length

    await vi.advanceTimersByTimeAsync(5000) // trailing timer must NOT fire
    expect(writes).toHaveLength(countAfterWriteNow)
  })
})
