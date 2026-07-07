import { describe, expect, it } from "vitest"
import {
  isMidMeetingJoin,
  nextLeaveState,
  nextMediaZeroSince,
  seedAttendees,
  shouldAskLanguage,
  shouldDrainTail,
  shouldEndFromMedia,
  shouldFinalizeStaleSession,
  shouldFinishRearmWait,
} from "../src/content/platforms/meet-lifecycle"

const GRACE = 8000
const THRESHOLD = 3

describe("isMidMeetingJoin", () => {
  const SETTLE = 10000
  it("marks a genuinely new device that arrives after the settle window", () => {
    expect(isMidMeetingJoin("Grace Hopper", "Ada Lovelace", false, 15000, SETTLE)).toBe(true)
  })
  it("does not mark a device already known this meeting", () => {
    expect(isMidMeetingJoin("Grace Hopper", "Ada Lovelace", true, 15000, SETTLE)).toBe(false)
  })
  it("does not mark a device within the settle window (initial roster / reload re-sync)", () => {
    expect(isMidMeetingJoin("Grace Hopper", "Ada Lovelace", false, 5000, SETTLE)).toBe(false)
    expect(isMidMeetingJoin("Grace Hopper", "Ada Lovelace", false, 0, SETTLE)).toBe(false)
  })
  it("never marks the local user (self) as joining", () => {
    expect(isMidMeetingJoin("Ada Lovelace", "Ada Lovelace", false, 15000, SETTLE)).toBe(false)
  })
  it("marks a new arrival when self name is not yet known", () => {
    expect(isMidMeetingJoin("Grace Hopper", null, false, 15000, SETTLE)).toBe(true)
  })
})
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

describe("shouldFinalizeStaleSession (don't overwrite a prior meeting in the same tab)", () => {
  // The bug: leaving meeting A via Meet's UI then joining a DIFFERENT meeting B in
  // the same tab reloads the content script, tearing A down before it finalized. A
  // is still under the tab key; B's first write would overwrite it. Finalize A
  // first so it reaches history and disk.
  it("finalizes when the stored session is a different meeting", () => {
    expect(shouldFinalizeStaleSession("/abc-defg-hij", "/xyz-wxyz-uvw")).toBe(true)
  })

  // A same-path stored session is a genuine reload-resume of the same meeting; it
  // is continued, not finalized — finalizing it would split one meeting in two.
  it("does NOT finalize a same-path session (genuine reload-resume)", () => {
    expect(shouldFinalizeStaleSession("/abc-defg-hij", "/abc-defg-hij")).toBe(false)
  })

  // First meeting of the tab: nothing stored yet, nothing to finalize.
  it("does NOT finalize when there is no stored session", () => {
    expect(shouldFinalizeStaleSession(null, "/abc-defg-hij")).toBe(false)
  })
})

describe("seedAttendees (participants known at join time)", () => {
  // The bug: roster device events stream from join time — often BEFORE the
  // meeting's recordAttendee is wired — so early participants landed in the page
  // roster but never in the attendee set. Seeding the set from the roster known at
  // join time captures them.
  it("unions resumed-prefix, roster, and self, in that order", () => {
    expect(seedAttendees(["Ann"], ["Bob", "Cleo"], "Me")).toEqual(["Ann", "Bob", "Cleo", "Me"])
  })

  it("captures roster names that arrived before wiring (the missing-participants bug)", () => {
    expect(seedAttendees([], ["Early Arrival", "Other"], null)).toEqual(["Early Arrival", "Other"])
  })

  it("dedupes by exact trimmed name, keeping first occurrence", () => {
    expect(seedAttendees(["Ann"], ["Ann", " Ann ", "Bob"], "Ann")).toEqual(["Ann", "Bob"])
  })

  it("trims and drops empty / whitespace-only names", () => {
    expect(seedAttendees(["  "], [" Bob ", ""], "  ")).toEqual(["Bob"])
  })

  it("omits self when it is null or blank", () => {
    expect(seedAttendees([], ["Bob"], null)).toEqual(["Bob"])
    expect(seedAttendees([], ["Bob"], "   ")).toEqual(["Bob"])
  })

  it("returns an empty list when nothing is known yet", () => {
    expect(seedAttendees([], [], null)).toEqual([])
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

describe("shouldAskLanguage", () => {
  it("asks only when enabled, on a fresh start, with UI visible", () => {
    expect(shouldAskLanguage(true, false, false)).toBe(true)
  })
  it("never asks when the setting is off", () => {
    expect(shouldAskLanguage(false, false, false)).toBe(false)
  })
  it("does not ask on a reload-resume (language already chosen)", () => {
    expect(shouldAskLanguage(true, true, false)).toBe(false)
  })
  it("does not ask while all UI is hidden", () => {
    expect(shouldAskLanguage(true, false, true)).toBe(false)
  })
})
