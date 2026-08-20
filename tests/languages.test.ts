import { describe, expect, it } from "vitest"
import {
  CAPTION_LANGUAGES,
  isDivider,
  LANGUAGE_SEPARATOR,
  MAX_FAVOURITE_LANGUAGES,
  orderedLanguages,
} from "../src/shared/languages"

const values = (rows: { value: string }[]) => rows.map((r) => r.value)

describe("orderedLanguages", () => {
  it("is the untouched list when nothing is pinned", () => {
    expect(orderedLanguages(CAPTION_LANGUAGES)).toEqual(CAPTION_LANGUAGES)
    expect(orderedLanguages(CAPTION_LANGUAGES, [])).toEqual(CAPTION_LANGUAGES)
  })

  it("puts the pinned languages first, in the order they were chosen", () => {
    const rows = orderedLanguages(CAPTION_LANGUAGES, ["es-MX", "ru-RU"])
    expect(values(rows).slice(0, 2)).toEqual(["es-MX", "ru-RU"])
  })

  it("keeps every language in the list — pinning reorders, it never hides", () => {
    const rows = orderedLanguages(CAPTION_LANGUAGES, ["pl-PL"])
    const present = values(rows).filter((v) => v !== LANGUAGE_SEPARATOR)
    expect(present).toHaveLength(CAPTION_LANGUAGES.length)
    for (const lang of CAPTION_LANGUAGES) expect(present).toContain(lang.value)
  })

  it("does not repeat a pinned language further down", () => {
    const rows = orderedLanguages(CAPTION_LANGUAGES, ["de-DE"])
    expect(values(rows).filter((v) => v === "de-DE")).toHaveLength(1)
  })

  it("separates the pinned block from the rest", () => {
    const rows = orderedLanguages(CAPTION_LANGUAGES, ["ru-RU", "en-US"])
    expect(isDivider(rows[2])).toBe(true)
    expect(rows[2].value).toBe(LANGUAGE_SEPARATOR)
    expect(rows.filter((r) => isDivider(r))).toHaveLength(1)
  })

  it("has no separator when there is nothing on one side of it", () => {
    // Nothing pinned: no divider.
    expect(orderedLanguages(CAPTION_LANGUAGES).some((r) => isDivider(r))).toBe(false)
    // Nothing left over: no divider either. Needs a list no longer than the cap,
    // since with the real list of 14 a cap of 3 always leaves a remainder.
    const two = CAPTION_LANGUAGES.slice(0, 2)
    const rows = orderedLanguages(two, two.map((l) => l.value))
    expect(rows.some((r) => isDivider(r))).toBe(false)
    expect(rows).toHaveLength(2)
  })

  it("stops at the maximum even if more were somehow stored", () => {
    const many = CAPTION_LANGUAGES.slice(0, 6).map((l) => l.value)
    const rows = orderedLanguages(CAPTION_LANGUAGES, many)
    const separatorAt = rows.findIndex(isDivider)
    expect(separatorAt).toBe(MAX_FAVOURITE_LANGUAGES)
  })

  it("ignores a tag that is not a known language rather than inventing one", () => {
    const rows = orderedLanguages(CAPTION_LANGUAGES, ["xx-XX", "ru-RU"])
    expect(values(rows)[0]).toBe("ru-RU")
    expect(values(rows)).not.toContain("xx-XX")
  })

  it("collapses a duplicate favourite", () => {
    const rows = orderedLanguages(CAPTION_LANGUAGES, ["ru-RU", "ru-RU", "en-US"])
    expect(values(rows).slice(0, 2)).toEqual(["ru-RU", "en-US"])
    expect(isDivider(rows[2])).toBe(true)
  })

  it("does not mutate the list it was given", () => {
    const copy = [...CAPTION_LANGUAGES]
    orderedLanguages(CAPTION_LANGUAGES, ["kk-KZ"])
    expect(CAPTION_LANGUAGES).toEqual(copy)
  })
})

describe("the language list itself", () => {
  it("gives every language a flag and a region code", () => {
    for (const lang of CAPTION_LANGUAGES) {
      expect(lang.flag, lang.value).toBeTruthy()
      expect(lang.code, lang.value).toMatch(/^[A-Z]{2}$/)
    }
  })

  it("uses the region half of the tag as the code", () => {
    // A flag is a place, and the only reason one is defensible here is that every
    // tag is region-qualified. If a code and its tag disagree, one of them is a
    // typo and the button would fly the wrong flag.
    for (const lang of CAPTION_LANGUAGES) {
      expect(lang.code, lang.value).toBe(lang.value.split("-")[1])
    }
  })

  it("has a distinct flag per entry", () => {
    // es-ES and es-MX are separate entries precisely so each can carry its own
    // flag; two entries sharing one would make the buttons ambiguous.
    const flags = CAPTION_LANGUAGES.map((l) => l.flag)
    expect(new Set(flags).size).toBe(flags.length)
  })

  it("builds each flag from the regional indicators for its code", () => {
    const A = 0x1f1e6
    for (const lang of CAPTION_LANGUAGES) {
      const expected = [...lang.code].map((c) => String.fromCodePoint(A + c.charCodeAt(0) - 65)).join("")
      expect(lang.flag, lang.value).toBe(expected)
    }
  })

  it("has no duplicate tags", () => {
    const values = CAPTION_LANGUAGES.map((l) => l.value)
    expect(new Set(values).size).toBe(values.length)
  })
})
