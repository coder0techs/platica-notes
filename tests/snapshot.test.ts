import { describe, expect, it } from "vitest"
import { meetingUrlOf, resolveSnapshot, sessionToMeeting, snapshotDebugEvents } from "../src/background/snapshot"
import { MERGE_GAP_MS } from "../src/background/merge"
import type { ActiveSession, Meeting } from "../src/shared/types"

function session(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    platform: "meet",
    path: "/abc-defg-hij",
    title: "Weekly sync",
    startedAt: "2026-06-18T10:00:00.000Z",
    isPrivate: false,
    transcript: [{ speaker: "Grace Hopper", startedAt: "2026-06-18T10:01:00.000Z", text: "Morning." }],
    chat: [],
    participants: ["Grace Hopper", "Ada Lovelace"],
    ...over,
  }
}

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    platform: "meet",
    title: "Weekly sync",
    startedAt: "2026-06-18T09:00:00.000Z",
    endedAt: "2026-06-18T09:40:00.000Z",
    isPrivate: false,
    transcript: [{ speaker: "Ada Lovelace", startedAt: "2026-06-18T09:05:00.000Z", text: "Earlier." }],
    chat: [],
    participants: ["Ada Lovelace"],
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    ...over,
  }
}

describe("sessionToMeeting", () => {
  it("carries the session's own language, falling back to the default", () => {
    expect(
      sessionToMeeting(session({ captionLanguage: "es-MX" }), {
        id: "x",
        endedAt: "2026-06-18T10:30:00.000Z",
        fallbackLanguage: "en-US",
      }).language,
    ).toBe("es-MX")
    expect(
      sessionToMeeting(session({ captionLanguage: undefined }), {
        id: "x",
        endedAt: "2026-06-18T10:30:00.000Z",
        fallbackLanguage: "en-US",
      }).language,
    ).toBe("en-US")
  })

  it("stamps endedAt from the caller, so a snapshot ends at the moment it was taken", () => {
    const m = sessionToMeeting(session(), {
      id: "x",
      endedAt: "2026-06-18T10:12:00.000Z",
      fallbackLanguage: "en-US",
    })
    expect(m.endedAt).toBe("2026-06-18T10:12:00.000Z")
    expect(m.startedAt).toBe("2026-06-18T10:00:00.000Z")
  })

  it("derives the join link from the meeting path, and omits it off-platform", () => {
    expect(meetingUrlOf(session())).toBe("https://meet.google.com/abc-defg-hij")
    expect(meetingUrlOf({ platform: "meet", path: undefined })).toBeUndefined()
    expect(meetingUrlOf({ platform: "zoom", path: "/abc-defg-hij" })).toBeUndefined()
  })

  it("defaults every optional collection, so a legacy session renders", () => {
    const m = sessionToMeeting(
      session({ participants: [], rawVersions: undefined, notes: undefined, participantEvents: undefined }),
      { id: "x", endedAt: "2026-06-18T10:30:00.000Z", fallbackLanguage: "en-US" },
    )
    expect(m.rawVersions).toEqual([])
    expect(m.notes).toEqual([])
    expect(m.participantEvents).toEqual([])
    expect(m.lite).toEqual([])
  })
})

describe("resolveSnapshot", () => {
  const opts = { mergeEnabled: true, gapMs: MERGE_GAP_MS }
  const partial = (): Meeting =>
    sessionToMeeting(session(), { id: "snap", endedAt: "2026-06-18T10:10:00.000Z", fallbackLanguage: "en-US" })

  it("returns the live partial untouched when merging is off", () => {
    const p = partial()
    expect(resolveSnapshot(p, [meeting()], { mergeEnabled: false, gapMs: MERGE_GAP_MS })).toBe(p)
  })

  it("returns the live partial when history holds nothing to merge with", () => {
    const p = partial()
    expect(resolveSnapshot(p, [], opts)).toBe(p)
  })

  it("folds a recent same-code visit in, keeping that visit's filename identity", () => {
    const prior = meeting()
    const merged = resolveSnapshot(partial(), [prior], opts)
    // startedAt and title are what the filename is built from: the snapshot has to
    // land on the file the finished meeting will land on.
    expect(merged.startedAt).toBe(prior.startedAt)
    expect(merged.title).toBe(prior.title)
    // A superset: the prior visit's transcript is still there, plus the live one.
    expect(merged.transcript.map((u) => u.text)).toEqual(["Earlier.", "Morning."])
    // visits > 1 is what tells the downloader to overwrite rather than uniquify.
    expect(merged.visits?.length).toBe(2)
  })

  it("does not fold in a visit that ended outside the merge window", () => {
    const old = meeting({ endedAt: "2026-06-18T08:00:00.000Z" })
    expect(resolveSnapshot(partial(), [old], opts).startedAt).toBe("2026-06-18T10:00:00.000Z")
  })

  it("never folds a private visit into a public one, or the reverse", () => {
    const priv = meeting({ isPrivate: true })
    expect(resolveSnapshot(partial(), [priv], opts).startedAt).toBe("2026-06-18T10:00:00.000Z")
  })

  it("picks the most recent mergeable visit when several qualify", () => {
    const older = meeting({ id: "old", startedAt: "2026-06-18T08:30:00.000Z", endedAt: "2026-06-18T09:00:00.000Z" })
    const newer = meeting({ id: "new", startedAt: "2026-06-18T09:30:00.000Z", endedAt: "2026-06-18T09:50:00.000Z" })
    expect(resolveSnapshot(partial(), [older, newer], opts).startedAt).toBe(newer.startedAt)
  })
})

describe("snapshotDebugEvents", () => {
  it("writes nothing when the debug log was never switched on", () => {
    expect(snapshotDebugEvents(session({ debug: undefined }), "2026-06-18T10:10:00.000Z")).toEqual([])
  })

  it("closes the dump with a snapshot marker, not a finalized one", () => {
    const s = session({ debug: [{ t: "2026-06-18T10:00:00.000Z", ctx: "rtc", msg: "channel" }] })
    const out = snapshotDebugEvents(s, "2026-06-18T10:10:00.000Z")
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ ctx: "bg", msg: "snapshot", utterances: 1, chat: 0, isPrivate: false })
  })

  it("leaves the live session's own debug array alone, so markers cannot accumulate", () => {
    const s = session({ debug: [{ t: "2026-06-18T10:00:00.000Z", ctx: "rtc", msg: "channel" }] })
    snapshotDebugEvents(s, "2026-06-18T10:10:00.000Z")
    snapshotDebugEvents(s, "2026-06-18T10:20:00.000Z")
    expect(s.debug).toHaveLength(1)
  })
})
