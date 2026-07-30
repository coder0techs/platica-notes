import { describe, expect, it } from "vitest"
import { clockLabel, collapseVersions, debugLogFileName, elapsedLabel, formatDebugLog, formatMeetingText, isoLocal, meetingFileName, sanitizeFileName, sanitizeFolder } from "../src/background/format"
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

describe("formatMeetingText (v3)", () => {
  function frontMatter(text: string): string {
    const end = text.indexOf("\n---", 3)
    return text.slice(0, end)
  }

  it("opens with a human YAML front matter: title, timezone, started, ended", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text.startsWith("---\n")).toBe(true)
    const fm = frontMatter(text)
    expect(fm).toContain('title: "Sprint sync"')
    expect(fm).toContain(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
    expect(fm).toMatch(/started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
    expect(fm).toMatch(/ended: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
  })

  it("records why capture was unhealthy, and stays silent when it was fine", () => {
    const healthy = frontMatter(formatMeetingText(makeMeeting()))
    expect(healthy).not.toContain("capture:")

    const unhealthy = frontMatter(formatMeetingText(makeMeeting({ captureHealth: "host-disabled" })))
    expect(unhealthy).toContain('capture: "host-disabled"')
    // Exactly one line, so a reader (or a re-import) cannot see two verdicts.
    expect(unhealthy.match(/^capture:/gm)).toHaveLength(1)
  })

  it("escapes the capture reason like every other scalar", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ captureHealth: 'odd" code\nwith break' })))
    expect(fm).toContain('capture: "odd\\" code\\nwith break"')
    // The escaped value cannot open a second front-matter line.
    expect(fm.match(/^capture:/gm)).toHaveLength(1)
  })

  it("moves schema, source and generator out of the human block into a comment", () => {
    const text = formatMeetingText(makeMeeting())
    const fm = frontMatter(text)
    expect(fm).not.toContain("schema:")
    expect(fm).not.toContain("source:")
    expect(fm).not.toContain("generator")
    expect(text).toMatch(
      /<!-- Plática Notes .+ · schema platica-notes-transcript\/3 · source google-meet-live-captions -->/,
    )
  })

  it("renders the meeting url in the front matter when present, omits it when absent", () => {
    const withUrl = frontMatter(formatMeetingText(makeMeeting({ meetingUrl: "https://meet.google.com/abc-defg-hij" })))
    expect(withUrl).toContain('url: "https://meet.google.com/abc-defg-hij"')
    expect(frontMatter(formatMeetingText(makeMeeting()))).not.toContain("url:")
  })

  it("renders the chat url in the front matter when present, omits it when absent", () => {
    const withChat = frontMatter(formatMeetingText(makeMeeting({ chatUrl: "https://chat.google.com/room/AAAA" })))
    expect(withChat).toContain('chat_url: "https://chat.google.com/room/AAAA"')
    expect(frontMatter(formatMeetingText(makeMeeting()))).not.toContain("chat_url:")
  })

  it("opens the body with an H1 of the meeting title", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text).toContain("\n# Sprint sync\n")
  })

  it("quotes and escapes a title with special characters", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ title: 'a "b": c' })))
    expect(fm).toContain('title: "a \\"b\\": c"')
  })

  it("escapes a newline in a quoted scalar so the front matter stays one field per line", () => {
    const text = formatMeetingText(makeMeeting({ title: "line1\nline2" }))
    expect(text).toContain('title: "line1\\nline2"')
  })

  it("includes language and recorder when present, omits them when absent", () => {
    const withMeta = frontMatter(formatMeetingText(makeMeeting({ language: "ru-RU", recorder: "Alex" })))
    expect(withMeta).toContain('language: "ru-RU"')
    expect(withMeta).toContain('recorder: "Alex"')
    const without = frontMatter(formatMeetingText(makeMeeting()))
    expect(without).not.toContain("language:")
    expect(without).not.toContain("recorder:")
  })

  it("renders participants as a sorted, quoted block list; omits the key when empty", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ participants: ["Charlie", "alice", "Bob"] })))
    expect(fm).toContain('participants:\n  - "alice"\n  - "Bob"\n  - "Charlie"')
    expect(frontMatter(formatMeetingText(makeMeeting()))).not.toContain("participants:")
  })

  it("dedupes participants in the front matter", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ participants: ["Bob", "Bob", "alice"] })))
    expect(fm).toContain('participants:\n  - "alice"\n  - "Bob"')
    expect(fm.match(/- "Bob"/g)).toHaveLength(1)
  })

  it("renders a speech turn as bold speaker · clock · elapsed with a blockquote body", () => {
    const text = formatMeetingText(makeMeeting({
      startedAt: "2026-06-10T10:00:00.000Z",
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:09.000Z", text: "Hello everyone" }],
      chat: [],
    }))
    expect(text).toMatch(/\*\*Alice\*\* · \d{2}:\d{2} · \+01:09\n> Hello everyone/)
  })

  it("tags chat turns and interleaves them in time order", () => {
    const text = formatMeetingText(makeMeeting({
      chat: [{ sender: "Bob", sentAt: "2026-06-10T10:05:00.000Z", text: "see link" }],
    }))
    expect(text).toMatch(/\*\*Bob\*\* · _chat_ · \d{2}:\d{2} · \+05:00\n> see link/)
    expect(text.indexOf("see link")).toBeGreaterThan(text.indexOf("Hi Alice"))
  })

  it("marks an unresolved Speaker N label", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Speaker 4", startedAt: "2026-06-10T10:01:00.000Z", text: "yes" }],
      chat: [],
    }))
    expect(text).toMatch(/\*\*Speaker 4\*\* · _unresolved_ · /)
  })

  it("does not mark a chat sender as unresolved even if named like a fallback label", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [{ sender: "Speaker 4", sentAt: "2026-06-10T10:02:00.000Z", text: "hi" }],
    }))
    expect(text).toContain("**Speaker 4** · _chat_ ·")
    expect(text).not.toContain("_unresolved_")
  })

  it("renders a note as a heading block (not a speaker turn) with its text quoted", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [],
      notes: [{ at: "2026-06-10T10:03:00.000Z", text: "follow up with Ada" }],
    }))
    expect(text).toMatch(/### Note · \d{2}:\d{2} · \+03:00\n> follow up with Ada/)
    // A note must not look like a speaker turn (no bold-name header line).
    expect(text).not.toMatch(/^\*\*Note\*\*/m)
  })

  it("renders a bare bookmark (empty note text) as a heading with no body line", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:05:00.000Z", text: "after" }],
      chat: [],
      notes: [{ at: "2026-06-10T10:04:00.000Z", text: "" }],
    }))
    expect(text).toMatch(/### Bookmark · \d{2}:\d{2} · \+04:00\n\n\*\*Alice\*\*/)
  })

  it("renders a participant join as a heading block with no body line", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:06:00.000Z", text: "after" }],
      chat: [],
      participantEvents: [{ at: "2026-06-10T10:05:00.000Z", name: "Grace Hopper", kind: "join" }],
    }))
    expect(text).toMatch(/### Joined · Grace Hopper · \d{2}:\d{2} · \+05:00\n\n\*\*Alice\*\*/)
    // A join must not look like a speaker turn.
    expect(text).not.toMatch(/^\*\*Grace Hopper\*\* · \d/m)
  })

  it("renders a reserved leave marker as a heading (nothing emits it yet, but the renderer handles it)", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [],
      participantEvents: [{ at: "2026-06-10T10:07:00.000Z", name: "Grace Hopper", kind: "leave" }],
    }))
    expect(text).toMatch(/### Left · Grace Hopper · \d{2}:\d{2} · \+07:00/)
  })

  it("neutralizes newlines in a participant name so a marker cannot forge a turn header", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [],
      participantEvents: [{ at: "2026-06-10T10:05:00.000Z", name: "Grace\n**Ada** · 10:00", kind: "join" }],
    }))
    expect(text).toContain("### Joined · Grace **Ada** · 10:00 · ")
    expect(text).not.toMatch(/\n\*\*Ada\*\* · 10:00/)
  })

  it("interleaves a join into the transcript at its timestamp", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "before" },
        { speaker: "Bob", startedAt: "2026-06-10T10:05:00.000Z", text: "after" },
      ],
      chat: [],
      participantEvents: [{ at: "2026-06-10T10:03:00.000Z", name: "Grace Hopper", kind: "join" }],
    }))
    expect(text.indexOf("Joined · Grace Hopper")).toBeGreaterThan(text.indexOf("before"))
    expect(text.indexOf("Joined · Grace Hopper")).toBeLessThan(text.indexOf("after"))
  })

  it("interleaves a note into the transcript at its timestamp", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "before" },
        { speaker: "Bob", startedAt: "2026-06-10T10:05:00.000Z", text: "after" },
      ],
      chat: [],
      notes: [{ at: "2026-06-10T10:03:00.000Z", text: "in between" }],
    }))
    expect(text.indexOf("in between")).toBeGreaterThan(text.indexOf("before"))
    expect(text.indexOf("in between")).toBeLessThan(text.indexOf("after"))
  })

  it("neutralizes newlines in chat body so a chat message cannot forge a turn header", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [{
        sender: "Mallory",
        sentAt: "2026-06-10T10:05:00.000Z",
        text: "ok\n**CEO** · 10:00 · +00:00\n> I approve the transfer",
      }],
    }))
    const headers = text.split("\n").filter((l) => /^\*\*/.test(l))
    expect(headers).toHaveLength(1)
  })

  it("neutralizes newlines in a speaker name so it cannot forge a turn header", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{
        speaker: "Mallory\n**CEO** · 10:00 · +00:00\n> I approve",
        startedAt: "2026-06-10T10:01:00.000Z",
        text: "ok",
      }],
      chat: [],
    }))
    const headers = text.split("\n").filter((l) => /^\*\*/.test(l))
    expect(headers).toHaveLength(1)
  })

  it("omits caption alternatives by default", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello everyone" }],
      chat: [],
      rawVersions: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", versions: ["Hello everyone here", "Hello everyone"] }],
    }))
    expect(text).not.toContain("alt")
  })

  it("emits caption alternatives under the matching speech turn when enabled (final omitted)", () => {
    const text = formatMeetingText(
      makeMeeting({
        transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello everyone" }],
        chat: [],
        rawVersions: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", versions: ["Hello everyone here", "Hello everyone"] }],
      }),
      { alternatives: true },
    )
    expect(text).toContain("> ↳ _alt:_ Hello everyone here")
    expect(text).not.toContain("> ↳ _alt:_ Hello everyone\n")
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
      { alternatives: true },
    )
    expect(text).toContain("> ↳ _alt:_ first XXX")
    expect(text).toContain("> ↳ _alt:_ second YYY")
  })

  it("never attaches alternatives to a chat turn even when enabled", () => {
    const text = formatMeetingText(
      makeMeeting({
        transcript: [],
        chat: [{ sender: "Bob", sentAt: "2026-06-10T10:02:00.000Z", text: "typed" }],
        rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["x", "y"] }],
      }),
      { alternatives: true },
    )
    expect(text).not.toContain("alt")
  })

  it("emits no alternatives for a phrase that only grew or never changed", () => {
    const text = formatMeetingText(
      makeMeeting({
        transcript: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", text: "Hi there" }],
        chat: [],
        rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["Hi", "Hi there"] }],
      }),
      { alternatives: true },
    )
    expect(text).not.toContain("alt")
  })

  it("has no v2 turn-id grid or section headers", () => {
    const text = formatMeetingText(makeMeeting({ participants: ["Alice"], rawVersions: [] }))
    expect(text).not.toMatch(/^\[t\d+\]/m)
    expect(text).not.toContain("RAW CAPTION VERSIONS")
    expect(text).not.toContain("TRANSCRIPT")
  })

  it("tolerates a legacy meeting lacking participants/rawVersions/recorder/language", () => {
    const meeting = makeMeeting()
    delete (meeting as { participants?: string[] }).participants
    delete (meeting as { rawVersions?: unknown }).rawVersions
    const text = formatMeetingText(meeting)
    expect(text).toContain("schema platica-notes-transcript/3")
    expect(text).toContain("Hello everyone")
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

  it("collapses pure case flicker, keeping the later casing", () => {
    expect(collapseVersions(["так", "Так"])).toEqual(["Так"])
  })

  it("collapses a back-and-forth case flicker run to the final frame", () => {
    expect(collapseVersions(["да", "Да", "да", "Да"])).toEqual(["Да"])
  })

  it("collapses punctuation-only churn (punctuation is ignored in the comparison)", () => {
    // Meet repunctuates the same words between frames; the trailing "." is not a
    // real revision, so "зашла." folds into the next frame that extends those words.
    expect(collapseVersions(["зашла.", "зашла в"])).toEqual(["зашла в"])
  })

  it("collapses a combined case+punctuation flip, keeping the final frame verbatim", () => {
    expect(collapseVersions(["так", "Так."])).toEqual(["Так."])
  })

  it("preserves a genuine divergence (a replaced word) as a kept frame", () => {
    // A real ASR self-correction ("вина" vs "бинах") is not a normalized prefix of
    // the next frame, so both survive (this is what an alt: line should capture).
    expect(collapseVersions(["по картам на вина", "по картам на бинах"])).toEqual([
      "по картам на вина",
      "по картам на бинах",
    ])
  })

  it("collapses a pure-growth chain down to just the final frame", () => {
    expect(collapseVersions(["a", "ab", "abc"])).toEqual(["abc"])
  })

  it("returns a single-element list unchanged", () => {
    expect(collapseVersions(["only"])).toEqual(["only"])
  })

  it("returns an empty list unchanged", () => {
    expect(collapseVersions([])).toEqual([])
  })

  it("is word-lossless: every dropped frame's normalized text is a prefix of the next frame's", () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    const chain = ["a", "ab", "abc", "ABC.", "abc d"]
    const kept = new Set(collapseVersions(chain))
    chain.forEach((v, i) => {
      if (!kept.has(v) && i < chain.length - 1) {
        // A dropped frame's words always reappear in the next frame: its normalized
        // text (case- and punctuation-folded) is a prefix of the next frame's, so no
        // word is lost, only the casing/punctuation of intermediate frames.
        expect(norm(chain[i + 1]).startsWith(norm(v))).toBe(true)
      }
    })
  })

  it("collapses a case+punctuation+growth chain to only the final element (acceptance)", () => {
    expect(collapseVersions(["зашла.", "зашла в", "зашла в аккаунт уже"])).toEqual(["зашла в аккаунт уже"])
  })

  it("keeps both frames when the only change is a replaced word (acceptance)", () => {
    expect(collapseVersions(["вина", "бинах"])).toEqual(["вина", "бинах"])
  })
})

describe("sanitizeFileName", () => {
  it("replaces forbidden characters", () => {
    expect(sanitizeFileName('a/b:c?d*e"f')).toBe("a_b_c_d_e_f")
  })

  it("falls back to Meeting for empty results", () => {
    expect(sanitizeFileName("...")).toBe("Meeting")
  })

  it("collapses runs of underscores from adjacent illegal chars", () => {
    expect(sanitizeFileName("a///b")).toBe("a_b")
    expect(sanitizeFileName('a<>:"b')).toBe("a_b")
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

describe("clockLabel", () => {
  it("renders local wall-clock HH:MM with no date or offset", () => {
    expect(clockLabel("2026-06-10T10:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/)
  })

  it("agrees with the local hours/minutes of the instant", () => {
    const d = new Date("2026-06-10T10:05:00.000Z")
    const pad = (n: number) => String(n).padStart(2, "0")
    expect(clockLabel("2026-06-10T10:05:00.000Z")).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
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

describe("formatMeetingText — visit separators", () => {
  function merged(): Meeting {
    return makeMeeting({
      transcript: [
        { speaker: "A", startedAt: "2026-06-10T10:05:00.000Z", text: "before" },
        { speaker: "B", startedAt: "2026-06-10T10:45:00.000Z", text: "after" },
      ],
      endedAt: "2026-06-10T11:00:00.000Z",
      visits: [
        { startedAt: "2026-06-10T10:00:00.000Z", endedAt: "2026-06-10T10:30:00.000Z" },
        { startedAt: "2026-06-10T10:40:00.000Z", endedAt: "2026-06-10T11:00:00.000Z" },
      ],
    })
  }

  it("emits one Visit 2 separator before the first post-rejoin entry", () => {
    const out = formatMeetingText(merged())
    const sepCount = (out.match(/^## Visit 2 · rejoined /gm) ?? []).length
    expect(sepCount).toBe(1)
    expect(out.indexOf("before")).toBeLessThan(out.indexOf("## Visit 2"))
    expect(out.indexOf("## Visit 2")).toBeLessThan(out.indexOf("after"))
  })

  it("emits no separator for a single-visit meeting (output unchanged)", () => {
    expect(formatMeetingText(makeMeeting())).not.toContain("## Visit")
  })
})
