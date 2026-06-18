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

describe("downloadDebugLog", () => {
  const events: DebugEvent[] = [{ t: "2026-06-18T10:00:00.000Z", ctx: "bg", msg: "finalized" }]

  it("always writes to the debug folder (regardless of privacy — gated upstream in index.ts)", async () => {
    await downloadDebugLog({ title: "T", startedAt: "2026-06-18T10:00:00.000Z" }, events)
    expect(chrome._downloads[0].filename.startsWith("meetings/platica-notes-logs/")).toBe(true)
    expect(chrome._downloads[0].filename.endsWith(".debug.jsonl")).toBe(true)
  })

  it("writes nothing for an empty event array", async () => {
    await downloadDebugLog({ title: "T", startedAt: "2026-06-18T10:00:00.000Z" }, [])
    expect(chrome._downloads).toHaveLength(0)
  })
})
