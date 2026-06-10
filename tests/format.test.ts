import { describe, expect, it } from "vitest"
import { formatMeetingText, meetingFileName, sanitizeFileName } from "../src/background/format"
import type { Meeting } from "../src/shared/types"

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    platform: "meet",
    title: "Sprint sync",
    startedAt: "2026-06-10T10:00:00.000Z",
    endedAt: "2026-06-10T10:30:00.000Z",
    localOnly: false,
    transcript: [
      { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello everyone" },
      { speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", text: "Hi Alice" },
    ],
    chat: [],
    driveStatus: "none",
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

  it("renders chat messages when present", () => {
    const text = formatMeetingText(makeMeeting({
      chat: [{ sender: "Bob", sentAt: "2026-06-10T10:05:00.000Z", text: "see link" }],
    }))
    expect(text).toContain("CHAT")
    expect(text).toContain("see link")
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

describe("meetingFileName", () => {
  it("matches shape: title + local date-time + .txt", () => {
    expect(meetingFileName(makeMeeting())).toMatch(/^Sprint sync \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.txt$/)
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
})
