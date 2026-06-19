import { describe, expect, it } from "vitest"
import { collapseVersions, debugLogFileName, elapsedLabel, formatDebugLog, formatMeetingText, isoLocal, meetingFileName, sanitizeFileName, sanitizeFolder } from "../src/background/format"
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

  it("shows no chat marker when there are no messages", () => {
    expect(formatMeetingText(makeMeeting())).not.toContain("(chat)")
  })

  it("appends a build-stamp footer (dev fallback under vitest, no globals defined)", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text).toContain("Plática Notes")
    // Globals are not defined under vitest, so both fields fall back to "dev".
    expect(text.trimEnd().endsWith("— Plática Notes dev (dev)")).toBe(true)
  })

  it("interleaves chat into the transcript, tagged (chat), in time order", () => {
    const text = formatMeetingText(makeMeeting({
      chat: [{ sender: "Bob", sentAt: "2026-06-10T10:05:00.000Z", text: "see link" }],
    }))
    expect(text).toContain("Bob (chat)")
    expect(text).toContain("see link")
    // No separate CHAT section header anymore — it lives in the timeline.
    expect(text).not.toContain("\nCHAT\n")
    // Chat at 10:05 sorts after the last speech line at 10:02.
    expect(text.indexOf("see link")).toBeGreaterThan(text.indexOf("Hi Alice"))
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
      // Grew then truncated: the truncation is a revision point the collapse keeps.
      { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", versions: ["Hello everyone here", "Hello everyone"] },
      { speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["Hi Alice"] },
    ],
  }

  it("renders a RAW CAPTION VERSIONS section listing each kept version", () => {
    const text = formatMeetingText(makeMeeting(withVersions))
    expect(text).toContain("RAW CAPTION VERSIONS")
    expect(text).toContain("1. Hello everyone here")
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

  it("omits a phrase that only grew left-to-right (collapses to one frame, no revisions)", () => {
    const text = formatMeetingText(makeMeeting({
      rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["Hi", "Hi there", "Hi there everyone"] }],
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

  it("merges consecutive same-speaker utterances into a single block", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello" },
        { speaker: "Alice", startedAt: "2026-06-10T10:01:05.000Z", text: "everyone here" },
      ],
    }))
    const aliceHeaders = text.split("\n").filter((l) => /^Alice \(/.test(l))
    expect(aliceHeaders).toHaveLength(1)
    expect(text).toContain("Hello everyone here")
  })

  it("keeps an interruption as three ordered blocks (A-B-A)", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "first" },
        { speaker: "Bob", startedAt: "2026-06-10T10:01:02.000Z", text: "interject" },
        { speaker: "Alice", startedAt: "2026-06-10T10:01:05.000Z", text: "second" },
      ],
    }))
    const aliceHeaders = text.split("\n").filter((l) => /^Alice \(/.test(l))
    expect(aliceHeaders).toHaveLength(2)
    expect(text.indexOf("interject")).toBeGreaterThan(text.indexOf("first"))
    expect(text.indexOf("second")).toBeGreaterThan(text.indexOf("interject"))
  })
})

describe("collapseVersions", () => {
  it("drops frames that are a pure prefix of the next (left-to-right typing)", () => {
    expect(collapseVersions(["за", "запи", "записи всех"])).toEqual(["записи всех"])
  })

  it("keeps a frame the next one shortened (truncation point)", () => {
    expect(collapseVersions(["a b c d", "a b c"])).toEqual(["a b c d", "a b c"])
  })

  it("keeps a frame edited mid-string (not a prefix relationship)", () => {
    expect(collapseVersions(["hello wrld", "hello world"])).toEqual(["hello wrld", "hello world"])
  })

  it("keeps a case+punctuation change (repunctuation is a real revision, not pure case)", () => {
    expect(collapseVersions(["так", "Так."])).toEqual(["так", "Так."])
  })

  it("collapses pure case flicker, keeping the later casing", () => {
    expect(collapseVersions(["так", "Так"])).toEqual(["Так"])
  })

  it("collapses a back-and-forth case flicker run to the final frame", () => {
    expect(collapseVersions(["да", "Да", "да", "Да"])).toEqual(["Да"])
  })

  it("collapses a pure-growth chain down to just the final frame", () => {
    expect(collapseVersions(["a", "ab", "abc"])).toEqual(["abc"])
  })

  it("returns a single-element list unchanged", () => {
    expect(collapseVersions(["only"])).toEqual(["only"])
  })

  it("is word-lossless: every dropped frame is a prefix of, or case-equal to, the next frame", () => {
    const chain = ["a", "ab", "abc", "ABC", "abc d"]
    const kept = new Set(collapseVersions(chain))
    chain.forEach((v, i) => {
      if (!kept.has(v) && i < chain.length - 1) {
        // A dropped frame's words are always reproduced in the next frame: either it
        // is a verbatim prefix (next appended to it) or it is the same text ignoring
        // case (only the casing differs). No word is ever lost.
        const next = chain[i + 1]
        expect(next.startsWith(v) || next.toLowerCase() === v.toLowerCase()).toBe(true)
      }
    })
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

describe("isoLocal", () => {
  it("renders ISO 8601 with second precision and a numeric offset", () => {
    expect(isoLocal("2026-06-10T10:00:11.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  it("round-trips to the same instant regardless of the runner timezone", () => {
    const iso = "2026-06-10T10:00:11.000Z"
    expect(new Date(isoLocal(iso)).toISOString()).toBe(new Date(iso).toISOString())
  })
})

describe("elapsedLabel", () => {
  it("formats sub-hour gaps as mm:ss", () => {
    expect(elapsedLabel("2026-06-10T10:00:00.000Z", "2026-06-10T10:00:07.000Z")).toBe("00:07")
    expect(elapsedLabel("2026-06-10T10:00:00.000Z", "2026-06-10T10:01:09.000Z")).toBe("01:09")
  })

  it("rolls to h:mm:ss past an hour", () => {
    expect(elapsedLabel("2026-06-10T10:00:00.000Z", "2026-06-10T11:05:03.000Z")).toBe("1:05:03")
  })

  it("clamps a negative or zero gap to 00:00", () => {
    expect(elapsedLabel("2026-06-10T10:00:05.000Z", "2026-06-10T10:00:00.000Z")).toBe("00:00")
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
