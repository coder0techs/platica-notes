import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeChromeMock, type ChromeMock } from "./helpers/chrome-mock"
import { downloadDebugLog, downloadMeeting } from "../src/background/export"
import type { DebugEvent, Meeting } from "../src/shared/types"

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    platform: "meet",
    title: "Sync test",
    startedAt: "2026-06-18T10:00:00.000Z",
    endedAt: "2026-06-18T10:30:00.000Z",
    isPrivate: false,
    transcript: [],
    chat: [],
    participants: [],
    ...over,
  }
}

let chrome: ChromeMock

beforeEach(() => {
  chrome = makeChromeMock()
  ;(globalThis as unknown as { chrome: ChromeMock }).chrome = chrome
})
afterEach(() => {
  delete (globalThis as unknown as { chrome?: ChromeMock }).chrome
})

describe("downloadMeeting — privacy folder routing", () => {
  it("a public meeting downloads under the public folder", async () => {
    await downloadMeeting(meeting({ isPrivate: false }))
    expect(chrome._downloads).toHaveLength(1)
    expect(chrome._downloads[0].filename.startsWith("meetings/platica-notes/")).toBe(true)
    expect(chrome._downloads[0].filename.endsWith(".md")).toBe(true)
    expect(chrome._downloads[0].conflictAction).toBe("uniquify")
  })

  it("a private meeting downloads under the private folder, never the public one", async () => {
    await downloadMeeting(meeting({ isPrivate: true }))
    expect(chrome._downloads[0].filename.startsWith("meetings/platica-notes-private/")).toBe(true)
    expect(chrome._downloads[0].filename.startsWith("meetings/platica-notes/")).toBe(false)
  })
})

// ar-1qz: a flat folder is unreadable after a week of meetings.
describe("downloadMeeting — month subfolders", () => {
  function monthOf(iso: string): string {
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  }

  it("files a meeting under a YYYY-MM subfolder of its configured folder", async () => {
    const startedAt = "2026-06-18T10:00:00.000Z"
    await downloadMeeting(meeting({ startedAt }))
    expect(chrome._downloads[0].filename.startsWith(`meetings/platica-notes/${monthOf(startedAt)}/`)).toBe(true)
  })

  it("uses the month the meeting STARTED in, so a call over midnight stays in one folder", async () => {
    const startedAt = "2026-06-30T22:00:00.000Z"
    await downloadMeeting(meeting({ startedAt, endedAt: "2026-07-01T01:00:00.000Z" }))
    expect(chrome._downloads[0].filename).toContain(`/${monthOf(startedAt)}/`)
  })

  it("applies to the private folder as well", async () => {
    const startedAt = "2026-06-18T10:00:00.000Z"
    await downloadMeeting(meeting({ isPrivate: true, startedAt }))
    expect(chrome._downloads[0].filename.startsWith(`meetings/platica-notes-private/${monthOf(startedAt)}/`)).toBe(true)
  })
})

describe("downloadMeeting — conflictAction by visit count", () => {
  it("a single-visit meeting uniquifies (never overwrites a sibling)", async () => {
    await downloadMeeting(meeting({}))
    expect(chrome._downloads[0].conflictAction).toBe("uniquify")
  })

  it("a merged meeting (visits > 1) overwrites its own growing file", async () => {
    await downloadMeeting(meeting({
      visits: [
        { startedAt: "2026-06-18T10:00:00.000Z", endedAt: "2026-06-18T10:30:00.000Z" },
        { startedAt: "2026-06-18T10:40:00.000Z", endedAt: "2026-06-18T11:00:00.000Z" },
      ],
    }))
    expect(chrome._downloads[0].conflictAction).toBe("overwrite")
  })

  // "Overwrite" only lands on the right file if the merged meeting resolves to the
  // exact same path as its first visit did — month folder and code included.
  it("a merged meeting resolves to the same path its first visit wrote", async () => {
    const first = meeting({
      startedAt: "2026-06-18T10:00:00.000Z",
      endedAt: "2026-06-18T10:30:00.000Z",
      meetingUrl: "https://meet.google.com/exb-zusa-qnc",
    })
    await downloadMeeting(first)
    await downloadMeeting({
      ...first,
      // A later visit advances endedAt; identity (title, startedAt, url) is kept.
      endedAt: "2026-06-18T11:00:00.000Z",
      visits: [
        { startedAt: "2026-06-18T10:00:00.000Z", endedAt: "2026-06-18T10:30:00.000Z" },
        { startedAt: "2026-06-18T10:40:00.000Z", endedAt: "2026-06-18T11:00:00.000Z" },
      ],
    })
    expect(chrome._downloads[1].filename).toBe(chrome._downloads[0].filename)
    expect(chrome._downloads[1].conflictAction).toBe("overwrite")
  })
})

describe("downloadDebugLog", () => {
  const events: DebugEvent[] = [{ t: "2026-06-18T10:00:00.000Z", ctx: "bg", msg: "finalized" }]

  it("always writes to the debug folder (regardless of privacy — gated upstream in index.ts)", async () => {
    await downloadDebugLog({ title: "T", startedAt: "2026-06-18T10:00:00.000Z" }, events)
    expect(chrome._downloads[0].filename.startsWith("meetings/platica-notes-logs/")).toBe(true)
    expect(chrome._downloads[0].filename.endsWith(".debug.jsonl")).toBe(true)
  })

  it("is filed by month too, so the log sits beside its meeting's month", async () => {
    await downloadDebugLog({ title: "T", startedAt: "2026-06-18T10:00:00.000Z" }, events)
    const d = new Date("2026-06-18T10:00:00.000Z")
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    expect(chrome._downloads[0].filename.startsWith(`meetings/platica-notes-logs/${month}/`)).toBe(true)
  })

  it("writes nothing for an empty event array", async () => {
    await downloadDebugLog({ title: "T", startedAt: "2026-06-18T10:00:00.000Z" }, [])
    expect(chrome._downloads).toHaveLength(0)
  })
})
