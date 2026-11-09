import { describe, expect, it } from "vitest"
import { meetingFolder, monthFolder, sanitizeFileName, sanitizeFolder } from "../src/shared/paths"
import { DEFAULT_SETTINGS } from "../src/shared/types"

// These helpers moved out of background/format.ts because the pages now show the
// user the path a file will take: the popup states where the running meeting is
// heading, and the settings page previews a folder as it is typed. The point of
// the shared module is that those two cannot promise a path the downloader does
// not use, so the tests here pin the shape all three depend on.

describe("sanitizeFileName", () => {
  it("replaces the characters a filesystem refuses", () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe("a_b_c_d_e_f_g_h_i_j")
  })

  it("strips control characters", () => {
    expect(sanitizeFileName("Weekly\u0007 sync")).toBe("Weekly_ sync")
  })

  it("trims leading and trailing dots and spaces", () => {
    expect(sanitizeFileName("  ..Roadmap.. ")).toBe("Roadmap")
  })

  it("falls back rather than returning an empty segment", () => {
    expect(sanitizeFileName("...")).toBe("Meeting")
    expect(sanitizeFileName("")).toBe("Meeting")
  })

  it("caps the length and does not leave a trailing dot behind", () => {
    const long = `${"x".repeat(119)}.tail`
    expect(sanitizeFileName(long)).toBe("x".repeat(119))
  })
})

describe("sanitizeFolder", () => {
  it("keeps a nested relative path", () => {
    expect(sanitizeFolder("meetings/work", "fallback")).toBe("meetings/work")
  })

  it("cannot escape Downloads", () => {
    expect(sanitizeFolder("../../etc", "fallback")).toBe("etc")
    expect(sanitizeFolder("../..", "fallback")).toBe("fallback")
  })

  it("never produces an absolute path", () => {
    expect(sanitizeFolder("/Users/someone/meetings", "fallback")).toBe("Users/someone/meetings")
  })

  it("drops empty and dot segments", () => {
    expect(sanitizeFolder("a//./b", "fallback")).toBe("a/b")
  })

  it("falls back when nothing survives", () => {
    expect(sanitizeFolder("", "fallback")).toBe("fallback")
    expect(sanitizeFolder("   ", "fallback")).toBe("fallback")
  })
})

describe("monthFolder", () => {
  it("buckets by the month the meeting started in, local time", () => {
    expect(monthFolder("2026-08-21T14:30:00")).toBe("2026-08")
  })

  it("pads a single-digit month", () => {
    expect(monthFolder("2026-01-02T09:00:00")).toBe("2026-01")
  })
})

describe("meetingFolder", () => {
  const settings = { folderPublic: "meetings/notes", folderPrivate: "meetings/notes-private" }

  it("uses the public folder for a normal meeting", () => {
    expect(meetingFolder({ ...settings, isPrivate: false, startedAt: "2026-08-21T10:00:00" })).toBe(
      "meetings/notes/2026-08",
    )
  })

  it("routes a private meeting to the private folder", () => {
    expect(meetingFolder({ ...settings, isPrivate: true, startedAt: "2026-08-21T10:00:00" })).toBe(
      "meetings/notes-private/2026-08",
    )
  })

  it("falls back per privacy flag when the configured folder is unusable", () => {
    expect(
      meetingFolder({ folderPublic: "..", folderPrivate: "", isPrivate: false, startedAt: "2026-08-21T10:00:00" }),
    ).toBe(`${DEFAULT_SETTINGS.folderPublic}/2026-08`)
    expect(
      meetingFolder({ folderPublic: "..", folderPrivate: "", isPrivate: true, startedAt: "2026-08-21T10:00:00" }),
    ).toBe(`${DEFAULT_SETTINGS.folderPrivate}/2026-08`)
  })
})

describe("sanitizeFileName: Windows reserved names", () => {
  it("suffixes a reserved device name so Windows does not refuse the download", () => {
    expect(sanitizeFileName("aux")).toBe("aux_")
    expect(sanitizeFileName("CON")).toBe("CON_")
    expect(sanitizeFileName("com1")).toBe("com1_")
    expect(sanitizeFileName("lpt9.md")).toBe("lpt9_.md")
    expect(sanitizeFileName("nul.tar.gz")).toBe("nul_.tar.gz")
  })

  it("leaves names that merely start with a reserved word alone", () => {
    expect(sanitizeFileName("console")).toBe("console")
    expect(sanitizeFileName("auxiliary notes")).toBe("auxiliary notes")
    expect(sanitizeFileName("com10")).toBe("com10")
  })

  it("applies per folder segment", () => {
    expect(sanitizeFolder("meetings/aux/2026", "x")).toBe("meetings/aux_/2026")
  })
})
