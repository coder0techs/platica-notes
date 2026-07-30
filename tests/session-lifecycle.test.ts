import { describe, expect, it } from "vitest"
import {
  isMidMeetingJoin,
  seedAttendees,
  shouldAskLanguage,
  shouldFinalizeStaleSession,
} from "../src/content/core/session-lifecycle"

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
