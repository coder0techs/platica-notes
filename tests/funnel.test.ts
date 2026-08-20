import { describe, expect, it } from "vitest"
import { emptyFunnel, funnelSnapshot, shouldRecordFunnel } from "../src/content/meet-rtc/funnel"

describe("shouldRecordFunnel", () => {
  const zeros = funnelSnapshot(emptyFunnel())
  const some = funnelSnapshot({ wire: 12, decoded: 12, dispatched: 12, dropped: 0 })

  it("records when the numbers moved", () => {
    expect(shouldRecordFunnel(some, zeros, false)).toBe(true)
  })

  it("skips a repeat of the same numbers on a tick", () => {
    // An idle meeting must not write the same line every thirty seconds.
    expect(shouldRecordFunnel(zeros, zeros, false)).toBe(false)
  })

  it("always records when asked to, even with nothing changed", () => {
    // This is the whole bug. These counters live for the page; the debug log is
    // written per meeting. A snapshot taken before the log window opened set the
    // baseline and silenced every snapshot inside it, so a broken meeting — the
    // one case worth measuring — recorded no funnel at all.
    expect(shouldRecordFunnel(zeros, zeros, true)).toBe(true)
  })

  it("records the first snapshot of a page, when nothing came before", () => {
    expect(shouldRecordFunnel(zeros, "", false)).toBe(true)
  })
})

describe("funnelSnapshot", () => {
  it("is stable for equal counts, so the dedupe compares like with like", () => {
    expect(funnelSnapshot({ wire: 1, decoded: 1, dispatched: 1, dropped: 0 })).toBe(
      funnelSnapshot({ wire: 1, decoded: 1, dispatched: 1, dropped: 0 }),
    )
  })

  it("differs as soon as any single counter moves", () => {
    const base = emptyFunnel()
    for (const key of ["wire", "decoded", "dispatched", "dropped"] as const) {
      expect(funnelSnapshot({ ...base, [key]: 1 }), key).not.toBe(funnelSnapshot(base))
    }
  })

  it("starts every counter at zero", () => {
    expect(emptyFunnel()).toEqual({ wire: 0, decoded: 0, dispatched: 0, dropped: 0 })
  })
})
