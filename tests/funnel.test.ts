import { describe, expect, it } from "vitest"
import { emptyFunnel, funnelSnapshot } from "../src/content/meet-rtc/funnel"

describe("emptyFunnel", () => {
  it("starts every counter at zero", () => {
    expect(emptyFunnel()).toEqual({ wire: 0, decoded: 0, dispatched: 0, dropped: 0 })
  })

  it("hands back a fresh object each time, so two pages cannot share counters", () => {
    const a = emptyFunnel()
    a.wire = 5
    expect(emptyFunnel().wire).toBe(0)
  })
})

describe("funnelSnapshot", () => {
  it("is stable for equal counts", () => {
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
})
