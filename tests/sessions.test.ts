import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeChromeMock, type ChromeMock } from "./helpers/chrome-mock"
import { finalizeSession, recoverOrphanSessions } from "../src/background/sessions"
import { listPendingExports } from "../src/background/store"
import type { ActiveSession, Meeting } from "../src/shared/types"

function makeSession(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    platform: "meet",
    path: "/abc-defg-hij",
    title: "Test meeting",
    startedAt: "2026-06-18T10:00:00.000Z",
    isPrivate: false,
    transcript: [],
    chat: [],
    participants: [],
    ...over,
  }
}

const oneUtterance = [{ speaker: "A", startedAt: "2026-06-18T10:00:01.000Z", text: "hi" }]

let chrome: ChromeMock

beforeEach(() => {
  chrome = makeChromeMock()
  ;(globalThis as unknown as { chrome: ChromeMock }).chrome = chrome
})
afterEach(() => {
  delete (globalThis as unknown as { chrome?: ChromeMock }).chrome
})

describe("finalizeSession", () => {
  it("empty session: stores no Meeting, removes the key, untracks the tab, carries isPrivate", async () => {
    chrome._store["session_7"] = makeSession({ isPrivate: true })
    chrome._store["activeSessionTabs"] = [7]
    const r = await finalizeSession(7)
    expect(r).not.toBeNull()
    expect(r!.meeting).toBeNull()
    expect(r!.isPrivate).toBe(true)
    expect(chrome._store["session_7"]).toBeUndefined()
    expect(chrome._store["meetings"]).toBeUndefined()
    expect(chrome._store["activeSessionTabs"]).toEqual([])
  })

  it("non-empty session: builds a Meeting, appends to history, removes the key", async () => {
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance })
    chrome._store["activeSessionTabs"] = [7]
    const r = await finalizeSession(7)
    expect(r!.meeting).not.toBeNull()
    expect(r!.meeting!.title).toBe("Test meeting")
    const meetings = chrome._store["meetings"] as Meeting[]
    expect(meetings).toHaveLength(1)
    expect(meetings[0].transcript).toHaveLength(1)
    expect(chrome._store["session_7"]).toBeUndefined()
    expect(chrome._store["activeSessionTabs"]).toEqual([])
  })

  it("carries isPrivate from a non-empty private session", async () => {
    chrome._store["session_3"] = makeSession({ isPrivate: true, transcript: oneUtterance })
    const r = await finalizeSession(3)
    expect(r!.isPrivate).toBe(true)
    expect(r!.meeting!.isPrivate).toBe(true)
  })

  it("carries the meeting url from the session path (meet)", async () => {
    chrome._store["session_5"] = makeSession({ transcript: oneUtterance, path: "/abc-defg-hij" })
    chrome._store["activeSessionTabs"] = [5]
    await finalizeSession(5)
    const meetings = chrome._store["meetings"] as Meeting[]
    expect(meetings[0].meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
  })

  it("returns null and does nothing when there is no backing session", async () => {
    const r = await finalizeSession(99)
    expect(r).toBeNull()
  })

  it("untracks a stale activeSessionTabs entry even with no backing session", async () => {
    chrome._store["activeSessionTabs"] = [42]
    await finalizeSession(42)
    expect(chrome._store["activeSessionTabs"]).toEqual([])
  })

  it("concurrent finalize of the same tab runs exactly once (reentrancy guard)", async () => {
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance })
    const [a, b] = await Promise.all([finalizeSession(7), finalizeSession(7)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect((chrome._store["meetings"] as Meeting[]) ?? []).toHaveLength(1)
  })

  it("marks the committed meeting as pending export (crash-resumable auto-export)", async () => {
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance })
    const r = await finalizeSession(7)
    expect(await listPendingExports()).toEqual([r!.meeting!.id])
  })

  it("does NOT mark an empty session as pending export", async () => {
    chrome._store["session_7"] = makeSession() // no transcript/chat
    await finalizeSession(7)
    expect(await listPendingExports()).toEqual([])
  })

  it("snapshots the recorder (self) name from the session", async () => {
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, selfName: "Grace Hopper" })
    const r = await finalizeSession(7)
    expect(r!.meeting!.recorder).toBe("Grace Hopper")
  })

  it("leaves recorder undefined when the session has no selfName", async () => {
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance })
    const r = await finalizeSession(7)
    expect(r!.meeting!.recorder).toBeUndefined()
  })

  it("snapshots the caption language from settings (default en-US)", async () => {
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance })
    const r = await finalizeSession(7)
    expect(r!.meeting!.language).toBe("en-US")
  })

  it("prefers the session's captured language over current settings", async () => {
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, captionLanguage: "es-ES" })
    const r = await finalizeSession(7)
    expect(r!.meeting!.language).toBe("es-ES")
  })

  it("carries notes and bookmarks into the finalized meeting (durability seam)", async () => {
    chrome._store["session_7"] = makeSession({
      transcript: oneUtterance,
      notes: [
        { at: "2026-06-18T10:00:05.000Z", text: "key decision" },
        { at: "2026-06-18T10:00:09.000Z", text: "" }, // bare bookmark
      ],
    })
    const r = await finalizeSession(7)
    expect(r!.meeting!.notes!.map((nt) => nt.text)).toEqual(["key decision", ""])
  })

  it("treats a notes-only session as non-empty (bookmarks alone are worth keeping)", async () => {
    chrome._store["session_8"] = makeSession({
      transcript: [],
      chat: [],
      notes: [{ at: "2026-06-18T10:00:05.000Z", text: "" }],
    })
    const r = await finalizeSession(8)
    expect(r!.meeting).not.toBeNull()
    expect(r!.meeting!.notes).toHaveLength(1)
  })

  it("a truly empty session (no transcript/chat/notes) stores no meeting", async () => {
    chrome._store["session_9"] = makeSession()
    const r = await finalizeSession(9)
    expect(r!.meeting).toBeNull()
  })
})

describe("finalizeSession — merge rejoined visits", () => {
  function withMerge() {
    chrome.storageSync["settings"] = { mergeRejoins: true }
  }
  // An already-finalized visit-1 meeting sitting in history, same code as makeSession.
  function seedVisit1(over: Partial<Meeting> = {}): Meeting {
    const m: Meeting = {
      id: "m1", platform: "meet", title: "Daily",
      startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:30:00.000Z",
      isPrivate: false, transcript: [{ speaker: "A", startedAt: "2026-06-30T10:05:00.000Z", text: "one" }],
      chat: [], participants: ["Ada"], meetingUrl: "https://meet.google.com/abc-defg-hij", ...over,
    }
    chrome._store["meetings"] = [m]
    return m
  }

  it("merges a sequential same-code visit into the seeded meeting (mergeRejoins on)", async () => {
    withMerge()
    seedVisit1()
    chrome._store["session_7"] = makeSession({
      transcript: [{ speaker: "B", startedAt: "2026-06-30T10:36:00.000Z", text: "two" }],
      startedAt: "2026-06-30T10:35:00.000Z",
    })
    await finalizeSession(7)

    const meetings = chrome._store["meetings"] as Meeting[]
    expect(meetings).toHaveLength(1)
    expect(meetings[0].id).toBe("m1") // target identity preserved
    expect(meetings[0].visits).toHaveLength(2)
    expect(meetings[0].transcript.map(u => u.text)).toEqual(["one", "two"])
  })

  it("keeps visits separate when mergeRejoins is off (default)", async () => {
    seedVisit1()
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, startedAt: "2026-06-30T10:35:00.000Z" })
    await finalizeSession(7)
    expect((chrome._store["meetings"] as Meeting[])).toHaveLength(2)
  })

  it("does not merge a private visit into a public one", async () => {
    withMerge()
    seedVisit1({ isPrivate: false })
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, startedAt: "2026-06-30T10:35:00.000Z", isPrivate: true })
    await finalizeSession(7)
    expect((chrome._store["meetings"] as Meeting[])).toHaveLength(2)
  })

  it("pending export tracks the merged (target) id, not the discarded incoming one", async () => {
    withMerge()
    seedVisit1()
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, startedAt: "2026-06-30T10:35:00.000Z" })
    const r = await finalizeSession(7)
    expect(r!.meeting!.id).toBe("m1")
    expect(await listPendingExports()).toEqual(["m1"])
  })
})

describe("recoverOrphanSessions", () => {
  it("finalizes sessions whose tab is gone and leaves live tabs alone", async () => {
    chrome._store["session_1"] = makeSession({ transcript: [{ speaker: "A", startedAt: "x", text: "dead" }] })
    chrome._store["session_2"] = makeSession({ transcript: [{ speaker: "B", startedAt: "x", text: "alive" }] })
    chrome._aliveTabs.add(2) // tab 2 is still open

    const recovered = await recoverOrphanSessions()

    expect(recovered).toHaveLength(1)
    expect(chrome._store["session_1"]).toBeUndefined() // dead tab finalized
    expect(chrome._store["session_2"]).toBeDefined() // live tab untouched
  })

  it("ignores non-session keys", async () => {
    chrome._store["meetings"] = []
    chrome._store["settings"] = {}
    const recovered = await recoverOrphanSessions()
    expect(recovered).toEqual([])
  })

  it("does NOT finalize a session whose tab errs transiently (only a confirmed 'no tab' is dead)", async () => {
    chrome._store["session_5"] = makeSession({ transcript: [{ speaker: "A", startedAt: "x", text: "live" }] })
    chrome._transientTabs.add(5) // tabs.get rejects, but NOT with "No tab with id"
    const recovered = await recoverOrphanSessions()
    expect(recovered).toEqual([])
    expect(chrome._store["session_5"]).toBeDefined() // left intact for the still-running meeting
  })
})
