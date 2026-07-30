import { describe, expect, it } from "vitest"
import { CHANNEL_WAIT_MS, healthMessage, isAlarming, nextHealth, type Health } from "../src/content/core/health"

const at = (s: number): string => new Date(Date.UTC(2026, 6, 30, 9, 0, s)).toISOString()

describe("capture health", () => {
  it("never alarms on silence alone once the channel is armed", () => {
    let health: Health = { code: "opening", since: at(0) }
    health = nextHealth(health, { kind: "channel-open", now: at(2) })
    expect(health.code).toBe("armed")
    // Ten minutes of a quiet meeting must stay armed, not raise an alarm.
    health = nextHealth(health, { kind: "tick", now: at(600) })
    expect(health.code).toBe("armed")
    expect(isAlarming(health.code)).toBe(false)
  })

  it("goes capturing on the first accepted utterance", () => {
    const health = nextHealth({ code: "armed", since: at(0) }, { kind: "utterance", now: at(3) })
    expect(health).toEqual({ code: "capturing", since: at(3) })
  })

  it("alarms when the channel never opened inside the window", () => {
    const opening: Health = { code: "opening", since: at(0) }
    // One second before the deadline: still waiting, no alarm.
    expect(nextHealth(opening, { kind: "tick", now: at(CHANNEL_WAIT_MS / 1000 - 1) }).code).toBe("opening")
    const timedOut = nextHealth(opening, { kind: "tick", now: at(CHANNEL_WAIT_MS / 1000) })
    expect(timedOut.code).toBe("no-channel")
    expect(isAlarming(timedOut.code)).toBe(true)
    // The timeout applies to the initial wait only, so it never fires again later.
    expect(nextHealth(timedOut, { kind: "tick", now: at(600) })).toBe(timedOut)
  })

  it("takes a platform-reported reason over its own inference", () => {
    const health = nextHealth({ code: "armed", since: at(0) }, { kind: "reported", code: "host-disabled", now: at(5) })
    expect(health.code).toBe("host-disabled")
    expect(healthMessage(health.code)).toContain("host")
  })

  it("keeps a detail string with a reported code", () => {
    const health = nextHealth(
      { code: "opening", since: at(0) },
      { kind: "reported", code: "unsupported-client", detail: "build 9.9.9", now: at(1) },
    )
    expect(health).toEqual({ code: "unsupported-client", since: at(1), detail: "build 9.9.9" })
  })

  it("returns to capturing after a recovered channel", () => {
    let health: Health = { code: "channel-lost", since: at(10) }
    health = nextHealth(health, { kind: "utterance", now: at(12) })
    expect(health.code).toBe("capturing")
    expect(isAlarming(health.code)).toBe(false)
  })

  it("does not demote a capturing session when the channel re-arms", () => {
    const capturing: Health = { code: "capturing", since: at(5) }
    expect(nextHealth(capturing, { kind: "channel-open", now: at(9) })).toBe(capturing)
  })

  it("keeps the same object (and the original `since`) when the code does not change", () => {
    const armed: Health = { code: "armed", since: at(2) }
    expect(nextHealth(armed, { kind: "channel-open", now: at(8) })).toBe(armed)
  })

  it("has a message for every alarming code and none for the healthy ones", () => {
    for (const code of ["no-channel", "channel-lost", "captions-off", "host-disabled", "unsupported-client"] as const) {
      expect(healthMessage(code).length).toBeGreaterThan(20)
    }
    for (const code of ["opening", "armed", "capturing"] as const) {
      expect(healthMessage(code)).toBe("")
    }
  })
})
