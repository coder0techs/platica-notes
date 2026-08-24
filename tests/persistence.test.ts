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

  it("on a context-invalidation write error, notifies once and stops writing", async () => {
    let writeCalls = 0
    let invalidatedCount = 0
    let counter = 0
    const writer = new SessionWriter<number>(
      async () => {
        writeCalls++
        throw new Error("Extension context invalidated.")
      },
      () => ++counter,
      1000,
      () => {
        invalidatedCount++
      },
    )

    writer.requestWrite()
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidatedCount).toBe(1)
    const callsAfterFirst = writeCalls

    // The writer must be sealed: further requests are no-ops (no retry storm) and
    // onInvalidated is not fired again.
    writer.requestWrite()
    await writer.writeNow()
    await vi.advanceTimersByTimeAsync(5000)
    expect(writeCalls).toBe(callsAfterFirst)
    expect(invalidatedCount).toBe(1)
  })

  describe("failing over when the context dies", () => {
    // An update mid-meeting severs this context's chrome.* handle. Capture itself
    // never stopped, so the writer must change transport rather than give up: the
    // alternative costs the rest of the meeting, and the only recovery is a page
    // reload that drops the user out of the call.
    const invalidated = () => new Error("Extension context invalidated.")

    it("switches to the fallback and keeps writing", async () => {
      const fallbackWrites: number[] = []
      const recovered: boolean[] = []
      let counter = 0
      const writer = new SessionWriter<number>(
        async () => {
          throw invalidated()
        },
        () => ++counter,
        1000,
        (ok) => recovered.push(ok),
        async (snapshot) => {
          fallbackWrites.push(snapshot)
        },
      )

      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(0)

      // Reported as recovered, not as a dead end.
      expect(recovered).toEqual([true])
      // And the snapshot that just failed is written straight away rather than
      // waiting for the next caption to arrive.
      expect(fallbackWrites).toHaveLength(1)
    })

    it("keeps accepting writes after the switch, and never touches the dead transport again", async () => {
      let primaryCalls = 0
      const fallbackWrites: number[] = []
      let counter = 0
      const writer = new SessionWriter<number>(
        async () => {
          primaryCalls++
          throw invalidated()
        },
        () => ++counter,
        1000,
        undefined,
        async (snapshot) => {
          fallbackWrites.push(snapshot)
        },
      )

      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(0)
      const callsAtSwitch = primaryCalls

      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(2000)
      await writer.writeNow()

      expect(primaryCalls).toBe(callsAtSwitch)
      expect(fallbackWrites.length).toBeGreaterThan(1)
    })

    it("seals only when the fallback dies too, and notifies exactly once", async () => {
      const recovered: boolean[] = []
      let fallbackCalls = 0
      let counter = 0
      const writer = new SessionWriter<number>(
        async () => {
          throw invalidated()
        },
        () => ++counter,
        1000,
        (ok) => recovered.push(ok),
        async () => {
          fallbackCalls++
          throw invalidated()
        },
      )

      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(0)
      const callsAtSeal = fallbackCalls

      // Sealed: no retry storm on a channel that is provably gone.
      writer.requestWrite()
      await writer.writeNow()
      await vi.advanceTimersByTimeAsync(5000)

      expect(fallbackCalls).toBe(callsAtSeal)
      expect(recovered).toEqual([true, false])
    })

    it("resolves writeNow only after the failover write has landed", async () => {
      // The end-of-meeting sequence is writeNow -> close -> finalize, and finalize
      // reads the snapshot back out of storage. If writeNow resolved while the
      // switched-to transport was still in flight, finalize would commit the
      // snapshot from BEFORE the last words of the meeting - the exact loss this
      // whole mechanism exists to prevent.
      const landed: number[] = []
      let counter = 0
      let releaseFallback!: () => void
      const fallbackGate = new Promise<void>((resolve) => {
        releaseFallback = resolve
      })
      const writer = new SessionWriter<number>(
        async () => {
          throw invalidated()
        },
        () => ++counter,
        1000,
        undefined,
        async (snapshot) => {
          await fallbackGate
          landed.push(snapshot)
        },
      )

      const done = writer.writeNow()
      let settled = false
      void done.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(settled).toBe(false)
      releaseFallback()
      await done
      expect(landed).toHaveLength(1)
    })

    it("does not seal on a transient fallback error", async () => {
      const fallbackWrites: number[] = []
      let fallbackCalls = 0
      let counter = 0
      const writer = new SessionWriter<number>(
        async () => {
          throw invalidated()
        },
        () => ++counter,
        1000,
        undefined,
        async (snapshot) => {
          fallbackCalls++
          if (fallbackCalls === 2) throw new Error("no receiving end right now")
          fallbackWrites.push(snapshot)
        },
      )

      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(0)
      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(2000)
      await writer.writeNow()

      // The transient failure is skipped, later writes still land.
      expect(fallbackWrites.length).toBeGreaterThanOrEqual(2)
    })

    it("still seals when there is no fallback at all", async () => {
      // The pre-existing contract: nothing to fail over to, so stop cleanly.
      const recovered: boolean[] = []
      let writeCalls = 0
      const writer = new SessionWriter<number>(
        async () => {
          writeCalls++
          throw invalidated()
        },
        () => 1,
        1000,
        (ok) => recovered.push(ok),
      )

      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(0)
      const calls = writeCalls
      writer.requestWrite()
      await vi.advanceTimersByTimeAsync(5000)

      expect(writeCalls).toBe(calls)
      expect(recovered).toEqual([false])
    })
  })

  it("a non-invalidation write error does not seal the writer or notify", async () => {
    const writes: number[] = []
    let invalidatedCount = 0
    let writeCalls = 0
    let counter = 0
    const writer = new SessionWriter<number>(
      async (snapshot) => {
        writeCalls++
        if (writeCalls === 1) throw new Error("disk full")
        writes.push(snapshot)
      },
      () => ++counter,
      1000,
      () => {
        invalidatedCount++
      },
    )

    writer.requestWrite()
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidatedCount).toBe(0)

    // Writer still works after a transient error.
    await writer.writeNow()
    expect(writes).toHaveLength(1)
    expect(invalidatedCount).toBe(0)
  })
})
