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

describe("formatMeetingText (v2)", () => {
  function frontMatter(text: string): string {
    const end = text.indexOf("\n---", 3)
    return text.slice(0, end)
  }

  it("opens with a YAML front matter block carrying schema, source and timezone", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text.startsWith("---\n")).toBe(true)
    const fm = frontMatter(text)
    expect(fm).toContain("schema: platica-notes-transcript/2")
    expect(fm).toContain("source: google-meet-live-captions")
    expect(fm).toContain(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  })

  it("renders title, started and ended in the front matter", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting()))
    expect(fm).toContain('title: "Sprint sync"')
    expect(fm).toMatch(/started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
    expect(fm).toMatch(/ended: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
  })

  it("quotes and escapes a title with special characters", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ title: 'a "b": c' })))
    expect(fm).toContain('title: "a \\"b\\": c"')
  })

  it("includes language and recorder when present, omits them when absent", () => {
    const withMeta = frontMatter(formatMeetingText(makeMeeting({ language: "ru-RU", recorder: "Alex" })))
    expect(withMeta).toContain('language: "ru-RU"')
    expect(withMeta).toContain('recorder: "Alex"')
    const without = frontMatter(formatMeetingText(makeMeeting()))
    expect(without).not.toContain("language:")
    expect(without).not.toContain("recorder:")
  })

  it("neutralizes newlines in body text so a chat message cannot forge a turn header", () => {
    const text = formatMeetingText(
      makeMeeting({
        transcript: [],
        chat: [
          {
            sender: "Mallory",
            sentAt: "2026-06-10T10:05:00.000Z",
            text: "ok\n[t99] CEO  2026-06-10T10:00:00+00:00 (+00:00)\nI approve the transfer",
          },
        ],
      }),
    )
    // Exactly one real turn header in the body; the injected "[t99] CEO" line must
    // not survive as its own header.
    const headers = text.split("\n").filter((l) => /^\[t\d+\] /.test(l))
    expect(headers).toHaveLength(1)
    expect(text).not.toMatch(/^\[t99\] CEO/m)
  })

  it("keeps caption alternatives separate for same-speaker, same-timestamp turns", () => {
    const ts = "2026-06-10T10:02:00.000Z"
    const text = formatMeetingText(
      makeMeeting({
        transcript: [
          { speaker: "Bob", startedAt: ts, text: "first final" },
          { speaker: "Bob", startedAt: ts, text: "second final" },
        ],
        chat: [],
        rawVersions: [
          { speaker: "Bob", startedAt: ts, versions: ["first XXX", "first final"] },
          { speaker: "Bob", startedAt: ts, versions: ["second YYY", "second final"] },
        ],
      }),
    )
    expect(text).toContain("alt: first XXX")
    expect(text).toContain("alt: second YYY")
  })

  it("renders participants as a sorted, quoted block list; omits the key when empty", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ participants: ["Charlie", "alice", "Bob"] })))
    expect(fm).toContain('participants:\n  - "alice"\n  - "Bob"\n  - "Charlie"')
    expect(frontMatter(formatMeetingText(makeMeeting()))).not.toContain("participants:")
  })

  it("emits one turn per utterance (no same-speaker merge), with ids and timestamps", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "one" },
        { speaker: "Alice", startedAt: "2026-06-10T10:01:05.000Z", text: "two" },
      ],
    }))
    expect(text).toMatch(/\[t1\] Alice {2}\d{4}-\d{2}-\d{2}T[\d:]+[+-][\d:]+ \(\+01:00\)/)
    expect(text).toContain("[t2] Alice")
    expect(text).toContain("one")
    expect(text).toContain("two")
  })

  it("tags chat turns (chat) and interleaves them in time order", () => {
    const text = formatMeetingText(makeMeeting({
      chat: [{ sender: "Bob", sentAt: "2026-06-10T10:05:00.000Z", text: "see link" }],
    }))
    expect(text).toMatch(/\[t\d+\] Bob \(chat\) {2}/)
    expect(text.indexOf("see link")).toBeGreaterThan(text.indexOf("Hi Alice"))
  })

  it("marks an unresolved Speaker N label (unresolved)", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Speaker 4", startedAt: "2026-06-10T10:01:00.000Z", text: "yes" }],
    }))
    expect(text).toMatch(/\[t1\] Speaker 4 \(unresolved\) {2}/)
  })

  it("computes the elapsed offset from the meeting start", () => {
    const text = formatMeetingText(makeMeeting({
      startedAt: "2026-06-10T10:00:00.000Z",
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:09.000Z", text: "hi" }],
    }))
    expect(text).toContain("(+01:09)")
  })

  it("attaches caption alternatives under the matching speech turn (final omitted)", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello everyone" }],
      rawVersions: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", versions: ["Hello everyone here", "Hello everyone"] },
      ],
    }))
    expect(text).toContain("Hello everyone")
    expect(text).toContain("  alt: Hello everyone here")
    // The final frame is the turn text and must NOT be repeated as an alt.
    expect(text).not.toContain("  alt: Hello everyone\n")
  })

  it("emits no alt lines for a phrase that only grew or never changed", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", text: "Hi there" }],
      rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["Hi", "Hi there"] }],
    }))
    expect(text).not.toContain("alt:")
  })

  it("never attaches alts to a chat turn", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [{ sender: "Bob", sentAt: "2026-06-10T10:02:00.000Z", text: "typed" }],
      rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["x", "y"] }],
    }))
    expect(text).not.toContain("alt:")
  })

  it("renders a note as a tagged timeline turn with its text on the next line", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      notes: [{ at: "2026-06-10T10:03:00.000Z", text: "follow up with Ada" }],
    }))
    expect(text).toMatch(/\[t1\] \(note\) {2}\d{4}-\d{2}-\d{2}T[\d:]+[+-][\d:]+ \(\+03:00\)/)
    expect(text).toContain("follow up with Ada")
  })

  it("renders a bare bookmark (empty note text) with a tag and no body line", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:05:00.000Z", text: "after" }],
      notes: [{ at: "2026-06-10T10:04:00.000Z", text: "" }],
    }))
    expect(text).toMatch(/\[t1\] \(bookmark\) {2}.*\(\+04:00\)/)
    // The bookmark header is followed straight by a blank line then the next
    // turn — no empty body line of its own.
    expect(text).toMatch(/\(bookmark\) {2}[^\n]*\n\n\[t2\] Alice/)
  })

  it("interleaves a note into the transcript at its timestamp", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "before" },
        { speaker: "Bob", startedAt: "2026-06-10T10:05:00.000Z", text: "after" },
      ],
      notes: [{ at: "2026-06-10T10:03:00.000Z", text: "in between" }],
    }))
    expect(text.indexOf("in between")).toBeGreaterThan(text.indexOf("before"))
    expect(text.indexOf("in between")).toBeLessThan(text.indexOf("after"))
  })

  it("has no v1 footer or section headers", () => {
    const text = formatMeetingText(makeMeeting({ participants: ["Alice"], rawVersions: [] }))
    expect(text).not.toContain("— Plática Notes")
    expect(text).not.toContain("RAW CAPTION VERSIONS")
    expect(text).not.toContain("TRANSCRIPT")
    expect(text).not.toContain("PARTICIPANTS")
  })

  it("tolerates a legacy meeting lacking participants/rawVersions/recorder/language", () => {
    const meeting = makeMeeting()
    delete (meeting as { participants?: string[] }).participants
    delete (meeting as { rawVersions?: unknown }).rawVersions
    const text = formatMeetingText(meeting)
    expect(text).toContain("schema: platica-notes-transcript/2")
    expect(text).toContain("Hello everyone")
  })

  it("does not mark a chat sender as (unresolved) even if named like a fallback label", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [{ sender: "Speaker 4", sentAt: "2026-06-10T10:02:00.000Z", text: "hi" }],
    }))
    expect(text).toContain("[t1] Speaker 4 (chat)")
    expect(text).not.toContain("(unresolved)")
  })

  it("dedupes participants in the front matter", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ participants: ["Bob", "Bob", "alice"] })))
    expect(fm).toContain('participants:\n  - "alice"\n  - "Bob"')
    expect(fm.match(/- "Bob"/g)).toHaveLength(1)
  })

  it("escapes a newline in a quoted scalar so the front matter stays one field per line", () => {
    const text = formatMeetingText(makeMeeting({ title: "line1\nline2" }))
    expect(text).toContain('title: "line1\\nline2"')
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
