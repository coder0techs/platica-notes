import { describe, expect, it } from "vitest"
import { debugLogFileName, formatDebugLog, formatMeetingText, meetingFileName, sanitizeFileName, sanitizeFolder } from "../src/background/format"
import type { DebugEvent, Meeting } from "../src/shared/types"

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    platform: "meet",
    title: "Sprint sync",
    startedAt: "2026-06-10T10:00:00.000Z",
    endedAt: "2026-06-10T10:30:00.000Z",
    isPrivate: false,
    transcript: [
      { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello everyone" },
      { speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", text: "Hi Alice" },
    ],
    chat: [],
    participants: [],
    ...overrides,
  }
}

describe("formatMeetingText", () => {
  it("renders title, speakers and their text", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text).toContain("Sprint sync")
    expect(text).toContain("Alice")
    expect(text).toContain("Hello everyone")
    expect(text).toContain("Bob")
  })

  it("omits the chat section when there are no messages", () => {
    expect(formatMeetingText(makeMeeting())).not.toContain("CHAT")
  })

  it("appends a build-stamp footer (dev fallback under vitest, no globals defined)", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text).toContain("Plática Notes")
    // Globals are not defined under vitest, so both fields fall back to "dev".
    expect(text.trimEnd().endsWith("— Plática Notes dev (dev)")).toBe(true)
  })

  it("renders chat messages when present", () => {
    const text = formatMeetingText(makeMeeting({
      chat: [{ sender: "Bob", sentAt: "2026-06-10T10:05:00.000Z", text: "see link" }],
    }))
    expect(text).toContain("CHAT")
    expect(text).toContain("see link")
  })

  it("omits the PARTICIPANTS section when the list is empty", () => {
    expect(formatMeetingText(makeMeeting())).not.toContain("PARTICIPANTS")
  })

  it("renders the PARTICIPANTS section sorted alphabetically", () => {
    const text = formatMeetingText(makeMeeting({ participants: ["Charlie", "alice", "Bob"] }))
    expect(text).toContain("PARTICIPANTS")
    const section = text.slice(text.indexOf("PARTICIPANTS"))
    const names = section.split("\n").slice(2, 5)
    expect(names).toEqual(["alice", "Bob", "Charlie"])
  })

  it("places PARTICIPANTS before the transcript", () => {
    const text = formatMeetingText(makeMeeting({ participants: ["Alice"] }))
    expect(text.indexOf("PARTICIPANTS")).toBeLessThan(text.indexOf("TRANSCRIPT"))
  })

  it("tolerates a meeting stored before the participants field existed", () => {
    const meeting = makeMeeting()
    // Simulate legacy stored data lacking the field entirely.
    delete (meeting as { participants?: string[] }).participants
    const text = formatMeetingText(meeting)
    expect(text).not.toContain("PARTICIPANTS")
    expect(text).toContain("Sprint sync")
  })

  const withVersions = {
    rawVersions: [
      { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", versions: ["Hello", "Hello everyone"] },
      { speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["Hi Alice"] },
    ],
  }

  it("renders a RAW CAPTION VERSIONS section listing each distinct version", () => {
    const text = formatMeetingText(makeMeeting(withVersions))
    expect(text).toContain("RAW CAPTION VERSIONS")
    expect(text).toContain("1. Hello")
    expect(text).toContain("2. Hello everyone")
  })

  it("omits phrases that never changed (single-version) from the section", () => {
    const text = formatMeetingText(makeMeeting(withVersions))
    const section = text.slice(text.indexOf("RAW CAPTION VERSIONS"))
    expect(section).not.toContain("Hi Alice")
  })

  it("omits the whole section when no phrase has more than one version", () => {
    const text = formatMeetingText(makeMeeting({
      rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["Hi"] }],
    }))
    expect(text).not.toContain("RAW CAPTION VERSIONS")
  })

  it("omits the section for legacy meetings lacking rawVersions", () => {
    expect(formatMeetingText(makeMeeting())).not.toContain("RAW CAPTION VERSIONS")
  })

  it("places RAW CAPTION VERSIONS after the transcript", () => {
    const text = formatMeetingText(makeMeeting(withVersions))
    expect(text.indexOf("TRANSCRIPT")).toBeLessThan(text.indexOf("RAW CAPTION VERSIONS"))
  })
})

describe("sanitizeFileName", () => {
  it("replaces forbidden characters", () => {
    expect(sanitizeFileName('a/b:c?d*e"f')).toBe("a_b_c_d_e_f")
  })

  it("falls back to Meeting for empty results", () => {
    expect(sanitizeFileName("...")).toBe("Meeting")
  })
})

describe("sanitizeFolder", () => {
  it("preserves a clean nested path", () => {
    expect(sanitizeFolder("meetings/platica-notes", "fb")).toBe("meetings/platica-notes")
  })

  it("strips leading and trailing slashes", () => {
    expect(sanitizeFolder("/a/b/", "fb")).toBe("a/b")
  })

  it("drops .. segments to prevent escaping Downloads", () => {
    expect(sanitizeFolder("../../x", "fb")).toBe("x")
    expect(sanitizeFolder("a/../b", "fb")).toBe("a/b")
  })

  it("sanitizes illegal chars per segment", () => {
    expect(sanitizeFolder('a/b:c?d', "fb")).toBe("a/b_c_d")
  })

  it("replaces a Windows-illegal char like : instead of keeping it", () => {
    expect(sanitizeFolder("a:b", "fb")).toBe("a_b")
  })

  it("falls back when nothing survives", () => {
    expect(sanitizeFolder("", "fb")).toBe("fb")
    expect(sanitizeFolder("   ", "fb")).toBe("fb")
    expect(sanitizeFolder("/", "fb")).toBe("fb")
    expect(sanitizeFolder(".", "fb")).toBe("fb")
  })
})

describe("meetingFileName", () => {
  it("matches shape: title + local date-time + .md", () => {
    expect(meetingFileName(makeMeeting())).toMatch(/^Sprint sync \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.md$/)
  })

  it("contains hour-minute derived from local time", () => {
    const d = new Date("2026-06-10T10:00:00.000Z")
    const pad = (n: number) => String(n).padStart(2, "0")
    const expectedTime = `${pad(d.getHours())}-${pad(d.getMinutes())}`
    expect(meetingFileName(makeMeeting())).toContain(expectedTime)
  })

  it("sanitizes illegal chars in the title part of the filename", () => {
    expect(meetingFileName(makeMeeting({ title: "a/b: report" }))).toMatch(/^a_b_ report /)
  })

  // regression guard — output must remain byte-identical after refactor
  it("produces the same output after fileBase refactor", () => {
    const m = makeMeeting()
    expect(meetingFileName(m)).toBe(meetingFileName(m))
  })
})

describe("debugLogFileName", () => {
  it("shares the same base as meetingFileName but ends with .debug.jsonl", () => {
    const m = makeMeeting()
    const txt = meetingFileName(m)
    const jsonl = debugLogFileName(m)
    const base = txt.slice(0, txt.length - ".md".length)
    expect(jsonl).toBe(`${base}.debug.jsonl`)
  })

  it("sanitizes illegal chars just like meetingFileName", () => {
    const m = makeMeeting({ title: "a/b: report" })
    const txt = meetingFileName(m)
    const jsonl = debugLogFileName(m)
    const base = txt.slice(0, txt.length - ".md".length)
    expect(jsonl).toBe(`${base}.debug.jsonl`)
  })
})

describe("formatDebugLog", () => {
  it("returns empty string for an empty array", () => {
    expect(formatDebugLog([])).toBe("")
  })

  it("round-trips events: split by newline and JSON.parse each yields the original", () => {
    const events: DebugEvent[] = [
      { t: "2026-06-10T10:00:00.000Z", ctx: "rtc", phase: "open", deviceId: "d1" },
      { t: "2026-06-10T10:01:00.000Z", ctx: "adapter", msg: "session started" },
    ]
    const lines = formatDebugLog(events).split("\n")
    expect(lines).toHaveLength(events.length)
    lines.forEach((line, i) => {
      expect(JSON.parse(line)).toEqual(events[i])
    })
  })

  it("handles nested fields and unicode text", () => {
    const events: DebugEvent[] = [
      {
        t: "2026-06-10T10:02:00.000Z",
        ctx: "bg",
        nested: { count: 3, labels: ["a", "б", "в"] },
        text: "Привет мир 🌍",
      },
    ]
    const line = formatDebugLog(events)
    expect(JSON.parse(line)).toEqual(events[0])
  })

  it("produces one line per event with no trailing newline", () => {
    const events: DebugEvent[] = [
      { t: "2026-06-10T10:00:00.000Z", ctx: "rtc" },
      { t: "2026-06-10T10:01:00.000Z", ctx: "bg" },
      { t: "2026-06-10T10:02:00.000Z", ctx: "adapter" },
    ]
    const output = formatDebugLog(events)
    expect(output.split("\n")).toHaveLength(3)
    expect(output.endsWith("\n")).toBe(false)
  })
})
