import { describe, expect, it } from "vitest"
import {
  nextLeaveState,
  nextMediaZeroSince,
  shouldDrainTail,
  shouldEndFromMedia,
  shouldFinishRearmWait,
} from "../src/content/platforms/meet-lifecycle"

const GRACE = 8000
const THRESHOLD = 3
const MEDIA_GRACE = 5000

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

describe("nextMediaZeroSince (track when all media sessions first dropped to zero)", () => {
  // While at least one media session is open, the call's media path is live, so
  // there is no pending end — keep zeroSince null no matter the prior value.
  it("stays null while sessions are open", () => {
    expect(nextMediaZeroSince(null, 1, 1000)).toBe(null)
    expect(nextMediaZeroSince(null, 2, 1000)).toBe(null)
  })

  // First observation of zero sessions stamps the moment — the grace timer starts.
  it("stamps the moment the count first reaches zero", () => {
    expect(nextMediaZeroSince(null, 0, 1000)).toBe(1000)
  })

  // Subsequent zero observations keep the ORIGINAL stamp, so the grace measures
  // from the first zero, not the latest poll.
  it("carries the first zero timestamp forward while it stays zero", () => {
    expect(nextMediaZeroSince(1000, 0, 3000)).toBe(1000)
  })

  // A session reopening (reconnect, make-before-break or a brief drop) cancels the
  // pending end: the next zero starts a fresh window, never the stale one.
  it("resets to null the instant a session reopens (reconnect cancels the pending end)", () => {
    expect(nextMediaZeroSince(1000, 1, 2000)).toBe(null)
  })
})

describe("shouldEndFromMedia (authoritative RTC end after grace)", () => {
  // No zero observed yet — the media path is up, never end.
  it("does NOT end while sessions are open (zeroSince null)", () => {
    expect(shouldEndFromMedia(null, 999999, MEDIA_GRACE)).toBe(false)
  })

  // Zero, but still inside the grace window — wait, it may be a reconnect.
  it("does NOT end before the grace elapses", () => {
    expect(shouldEndFromMedia(1000, 1000 + MEDIA_GRACE - 1, MEDIA_GRACE)).toBe(false)
  })

  // Zero sustained past the grace — the call's media path is authoritatively down.
  it("ends once the count has been zero for the full grace (kicked / host ended)", () => {
    expect(shouldEndFromMedia(1000, 1000 + MEDIA_GRACE, MEDIA_GRACE)).toBe(true)
    expect(shouldEndFromMedia(1000, 1000 + MEDIA_GRACE + 2000, MEDIA_GRACE)).toBe(true)
  })
})
