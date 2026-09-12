import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeChromeMock, type ChromeMock } from "./helpers/chrome-mock"
import {
  downloadDebugLog,
  downloadDebugSnapshot,
  downloadLiteLog,
  downloadMeeting,
  downloadSnapshot,
  eraseDownloadRows,
} from "../src/background/export"
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

describe("downloadLiteLog", () => {
  const lite: DebugEvent[] = [{ t: "2026-06-18T10:00:00.000Z", ctx: "rtc", phase: "funnel", wire: 0 }]

  it("names the file so nobody confuses it with the log that holds the meeting", async () => {
    await downloadLiteLog(meeting({ lite }))
    expect(chrome._downloads[0].filename.endsWith(".diagnostics.jsonl")).toBe(true)
  })

  it("writes it for a PRIVATE meeting too, which the full debug log never is", async () => {
    // The privacy flag protects content, and there is none in this file.
    await downloadLiteLog(meeting({ lite, isPrivate: true }))
    expect(chrome._downloads.length).toBe(1)
    expect(chrome._downloads[0].filename.startsWith("meetings/platica-notes-logs/")).toBe(true)
  })

  it("writes nothing when the meeting recorded no diagnostics", async () => {
    await downloadLiteLog(meeting({ lite: [] }))
    await downloadLiteLog(meeting())
    expect(chrome._downloads.length).toBe(0)
  })

  it("writes one JSON object per line, exactly what was collected", async () => {
    await downloadLiteLog(meeting({ lite }))
    const body = decodeURIComponent(chrome._downloads[0].url.split(",")[1])
    expect(JSON.parse(body)).toEqual(lite[0])
  })
})

describe("downloadSnapshot — saving mid-meeting", () => {
  const AT = "2026-06-18T10:12:00.000Z"
  const body = (url: string): string => decodeURIComponent(url.slice(url.indexOf(",") + 1))

  it("writes to the very path the finished meeting will write to", async () => {
    const m = meeting()
    const { path } = await downloadSnapshot(m, AT)
    chrome._downloads.length = 0
    await downloadMeeting(m)
    expect(chrome._downloads[0].filename).toBe(path)
  })

  it("carries the incomplete notice, which the finished file then replaces", async () => {
    await downloadSnapshot(meeting(), AT)
    expect(body(chrome._downloads[0].url)).toContain("status: in-progress")
    expect(body(chrome._downloads[0].url)).toContain("INCOMPLETE")
    chrome._downloads.length = 0
    await downloadMeeting(meeting())
    expect(body(chrome._downloads[0].url)).not.toContain("status: in-progress")
    expect(body(chrome._downloads[0].url)).not.toContain("INCOMPLETE")
  })

  it("a private meeting saves into the private folder, never the public one", async () => {
    await downloadSnapshot(meeting({ isPrivate: true }), AT)
    expect(chrome._downloads[0].filename.startsWith("meetings/platica-notes-private/")).toBe(true)
  })

  it("the first save uniquifies, so it cannot clobber an unrelated file of the same name", async () => {
    await downloadSnapshot(meeting(), AT)
    expect(chrome._downloads[0].conflictAction).toBe("uniquify")
  })

  it("every later save replaces the file it already wrote", async () => {
    const first = await downloadSnapshot(meeting(), AT)
    await downloadSnapshot(meeting(), "2026-06-18T10:20:00.000Z", { transcript: first.path })
    expect(chrome._downloads[1].conflictAction).toBe("overwrite")
    expect(chrome._downloads[1].filename).toBe(first.path)
  })

  it("the finished transcript replaces the partial one instead of landing beside it", async () => {
    const m = meeting()
    const { path } = await downloadSnapshot(m, AT)
    chrome._downloads.length = 0
    await downloadMeeting(m, { transcript: path })
    expect(chrome._downloads[0].filename).toBe(path)
    expect(chrome._downloads[0].conflictAction).toBe("overwrite")
  })

  it("a meeting nothing was ever saved for still uniquifies at the end", async () => {
    await downloadMeeting(meeting(), { transcript: "some/other/file.md" })
    expect(chrome._downloads[0].conflictAction).toBe("uniquify")
  })

  it("tidies the download rows its own earlier saves left behind", async () => {
    await downloadMeeting(meeting(), { rows: [7, 8] })
    expect(chrome._erased).toEqual([7, 8])
  })

  it("erasing rows that are already gone is not an error", async () => {
    await expect(eraseDownloadRows(undefined)).resolves.toBeUndefined()
  })
})

describe("downloadDebugSnapshot", () => {
  const meta = { title: "Sync test", startedAt: "2026-06-18T10:00:00.000Z" }
  const events: DebugEvent[] = [{ t: "2026-06-18T10:00:00.000Z", ctx: "rtc", msg: "channel" }]

  it("writes nothing when the debug log was never switched on", async () => {
    expect(await downloadDebugSnapshot(meta, [])).toBeNull()
    expect(chrome._downloads).toHaveLength(0)
  })

  it("replaces its own earlier dump rather than piling up numbered copies", async () => {
    const first = await downloadDebugSnapshot(meta, events)
    expect(first).not.toBeNull()
    expect(chrome._downloads[0].conflictAction).toBe("uniquify")
    await downloadDebugSnapshot(meta, events, { debug: first!.path })
    expect(chrome._downloads[1].conflictAction).toBe("overwrite")
  })

  it("the finished debug log replaces the dump a mid-meeting save left", async () => {
    const first = await downloadDebugSnapshot(meta, events)
    chrome._downloads.length = 0
    await downloadDebugLog(meta, events, { debug: first!.path })
    expect(chrome._downloads[0].filename).toBe(first!.path)
    expect(chrome._downloads[0].conflictAction).toBe("overwrite")
  })
})
