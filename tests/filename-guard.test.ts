import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeChromeMock, type ChromeMock } from "./helpers/chrome-mock"
import { FilenameGuard, installFilenameGuard } from "../src/background/filename-guard"
import { downloadMeeting } from "../src/background/export"
import type { Meeting } from "../src/shared/types"

const OURS = "platica-notes-test"

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

describe("FilenameGuard — claiming", () => {
  it("claims by exact url, whatever the order downloads are determined in", () => {
    const guard = new FilenameGuard()
    guard.expect({ url: "data:,a", filename: "notes/a.md", conflictAction: "uniquify" })
    guard.expect({ url: "data:,b", filename: "notes/b.md", conflictAction: "overwrite" })

    expect(guard.claim("data:,b", true)?.filename).toBe("notes/b.md")
    expect(guard.claim("data:,a", true)?.filename).toBe("notes/a.md")
    expect(guard.size).toBe(0)
  })

  it("carries the conflictAction alongside the name", () => {
    const guard = new FilenameGuard()
    guard.expect({ url: "data:,a", filename: "notes/a.md", conflictAction: "overwrite" })
    expect(guard.claim("data:,a", true)?.conflictAction).toBe("overwrite")
  })

  it("falls back to FIFO for our own download when the url comes back changed", () => {
    // Chrome does not promise to hand a multi-megabyte data: URL back verbatim.
    const guard = new FilenameGuard()
    guard.expect({ url: "data:,long-payload", filename: "notes/a.md", conflictAction: "uniquify" })
    expect(guard.claim("data:,trunc…", true)?.filename).toBe("notes/a.md")
  })

  it("claims nothing for a foreign download, so a stale entry cannot rename someone else's file", () => {
    const guard = new FilenameGuard()
    guard.expect({ url: "data:,a", filename: "notes/a.md", conflictAction: "uniquify" })
    expect(guard.claim("https://example.test/report.pdf", false)).toBeUndefined()
    expect(guard.size).toBe(1)
  })

  it("claims nothing when nothing is pending", () => {
    expect(new FilenameGuard().claim("data:,a", true)).toBeUndefined()
  })

  it("forgets an entry whose download never started", () => {
    const guard = new FilenameGuard()
    guard.expect({ url: "data:,a", filename: "notes/a.md", conflictAction: "uniquify" })
    guard.forget("data:,a")
    expect(guard.size).toBe(0)
    expect(guard.claim("data:,a", true)).toBeUndefined()
  })

  it("drops the oldest entries instead of growing without bound", () => {
    const guard = new FilenameGuard()
    for (let i = 0; i < 20; i++) {
      guard.expect({ url: `data:,${i}`, filename: `notes/${i}.md`, conflictAction: "uniquify" })
    }
    expect(guard.size).toBe(8)
    expect(guard.claim("data:,0", true)?.filename).toBe("notes/12.md") // oldest survivor, by FIFO
  })
})

describe("installFilenameGuard — answering Chrome", () => {
  let chrome: ChromeMock

  beforeEach(() => {
    chrome = makeChromeMock()
    ;(globalThis as unknown as { chrome: ChromeMock }).chrome = chrome
  })
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: ChromeMock }).chrome
  })

  function determine(item: { url: string; finalUrl?: string; byExtensionId?: string }) {
    const calls: Array<{ filename: string; conflictAction?: string } | undefined> = []
    for (const listener of chrome._determiners) listener(item, s => calls.push(s))
    return calls
  }

  it("re-asserts the name we asked for", () => {
    const guard = new FilenameGuard()
    guard.expect({ url: "data:,a", filename: "notes/a.md", conflictAction: "overwrite" })
    installFilenameGuard(guard)

    expect(determine({ url: "data:,a", byExtensionId: OURS })).toEqual([
      { filename: "notes/a.md", conflictAction: "overwrite" },
    ])
  })

  it("prefers finalUrl over url when both are present", () => {
    const guard = new FilenameGuard()
    guard.expect({ url: "data:,final", filename: "notes/a.md", conflictAction: "uniquify" })
    installFilenameGuard(guard)

    expect(determine({ url: "data:,original", finalUrl: "data:,final", byExtensionId: OURS })).toEqual([
      { filename: "notes/a.md", conflictAction: "uniquify" },
    ])
  })

  it("answers exactly once with no suggestion for a foreign download", () => {
    // The contract our neighbours broke: suggest() must be called exactly once,
    // and a bare call leaves the download to Chrome.
    installFilenameGuard(new FilenameGuard())
    expect(determine({ url: "https://example.test/report.pdf", byExtensionId: "someone-else" })).toEqual([undefined])
  })

  it("answers exactly once even for our own download with nothing pending", () => {
    installFilenameGuard(new FilenameGuard())
    expect(determine({ url: "data:,a", byExtensionId: OURS })).toEqual([undefined])
  })

  it("warns instead of throwing when the event is unavailable", () => {
    // Throwing at service-worker top level would take every other feature down
    // with it, and failing silently would leave a reader convinced the guard is
    // working. Neither is acceptable, so it says so and carries on.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    delete (chrome.downloads as { onDeterminingFilename?: unknown }).onDeterminingFilename

    expect(() => installFilenameGuard(new FilenameGuard())).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe("export → guard integration", () => {
  let chrome: ChromeMock

  beforeEach(() => {
    chrome = makeChromeMock()
    ;(globalThis as unknown as { chrome: ChromeMock }).chrome = chrome
  })
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: ChromeMock }).chrome
  })

  it("a meeting download is re-asserted with the same name it requested", async () => {
    installFilenameGuard()
    await downloadMeeting(meeting())
    const requested = chrome._downloads[0]

    const calls: Array<{ filename: string; conflictAction?: string } | undefined> = []
    for (const listener of chrome._determiners) {
      listener({ url: requested.url, byExtensionId: OURS }, s => calls.push(s))
    }
    expect(calls).toEqual([{ filename: requested.filename, conflictAction: requested.conflictAction }])
  })

  it("does not leave a name pending when the download call throws", async () => {
    // Otherwise the next foreign download attributed to us would inherit this
    // meeting's name through the FIFO fall back.
    installFilenameGuard()
    chrome.downloads.download = () => Promise.reject(new Error("user cancelled"))

    await expect(downloadMeeting(meeting())).rejects.toThrow("user cancelled")

    const calls: Array<{ filename: string; conflictAction?: string } | undefined> = []
    for (const listener of chrome._determiners) {
      listener({ url: "data:,anything", byExtensionId: OURS }, s => calls.push(s))
    }
    expect(calls).toEqual([undefined])
  })
})
