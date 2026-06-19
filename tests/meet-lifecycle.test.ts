import { describe, expect, it } from "vitest"
import { nextLeaveState, shouldDrainTail, shouldFinishRearmWait } from "../src/content/platforms/meet-lifecycle"

const GRACE = 8000
const THRESHOLD = 3

describe("shouldDrainTail (phantom-duplicate grace)", () => {
  it("drains: same code re-entered within the grace window", () => {
    expect(shouldDrainTail("/abc-defg-hij", "/abc-defg-hij", 1000, 1000 + 2000, GRACE)).toBe(true)
  })
  it("starts normally: same code re-entered AFTER the grace window (genuine rejoin)", () => {
    expect(shouldDrainTail("/abc-defg-hij", "/abc-defg-hij", 1000, 1000 + GRACE + 1, GRACE)).toBe(false)
  })
  it("starts normally: a different code within the window (soft-nav to a new meeting)", () => {
    expect(shouldDrainTail("/new-code-xyz", "/abc-defg-hij", 1000, 1000 + 2000, GRACE)).toBe(false)
  })
  it("starts normally: first meeting of the tab (no prior path)", () => {
    expect(shouldDrainTail("/abc-defg-hij", "", 0, 5000, GRACE)).toBe(false)
  })
})

describe("shouldFinishRearmWait (re-arm after a meeting ends, never deadlock)", () => {
  // Normal leave: the residual leave icon clears on the post-leave screen, so the
  // re-arm wait finishes as soon as it is gone.
  it("finishes immediately once the leave icon has cleared", () => {
    expect(shouldFinishRearmWait(true, 0, GRACE)).toBe(true)
  })

  // Fast rejoin: the user is back in the call before the wait begins, so the
  // call_end icon is present again and never clears. The wait MUST still finish at
  // the grace cap — otherwise the loop blocks forever and the rejoined session is
  // never recorded (the transcript-loss bug).
  it("finishes at the grace cap even if the icon never clears (fast rejoin)", () => {
    expect(shouldFinishRearmWait(false, GRACE, GRACE)).toBe(true)
    expect(shouldFinishRearmWait(false, GRACE + 500, GRACE)).toBe(true)
  })

  // While the icon is still present and the cap has not elapsed, keep waiting so a
  // residual post-leave icon does not instantly re-trigger a phantom join.
  it("keeps waiting while the icon is present and the cap has not elapsed", () => {
    expect(shouldFinishRearmWait(false, 0, GRACE)).toBe(false)
    expect(shouldFinishRearmWait(false, GRACE - 1, GRACE)).toBe(false)
  })
})

describe("nextLeaveState (leave detection)", () => {
  it("ends immediately when the meeting path changes", () => {
    expect(nextLeaveState(true, true, 0, THRESHOLD)).toEqual({ end: true, reason: "left meeting page", goneCount: 0 })
  })

  it("does NOT end on a single icon flicker (resets toward zero while present)", () => {
    expect(nextLeaveState(false, true, 2, THRESHOLD)).toEqual({ end: false, reason: "", goneCount: 0 })
  })

  it("tolerates the icon missing for fewer than the threshold consecutive checks", () => {
    const first = nextLeaveState(false, false, 0, THRESHOLD)
    expect(first).toEqual({ end: false, reason: "", goneCount: 1 })
    const second = nextLeaveState(false, false, first.goneCount, THRESHOLD)
    expect(second).toEqual({ end: false, reason: "", goneCount: 2 })
  })

  it("ends after the icon is missing for the threshold consecutive checks (kicked / host ended)", () => {
    expect(nextLeaveState(false, false, 2, THRESHOLD)).toEqual({ end: true, reason: "call ended", goneCount: 3 })
  })

  it("a present icon between misses prevents the count from reaching the threshold", () => {
    let gone = 0
    gone = nextLeaveState(false, false, gone, THRESHOLD).goneCount // 1
    gone = nextLeaveState(false, true, gone, THRESHOLD).goneCount // reset to 0 (flicker recovered)
    const step = nextLeaveState(false, false, gone, THRESHOLD)
    expect(step).toEqual({ end: false, reason: "", goneCount: 1 })
  })
})
