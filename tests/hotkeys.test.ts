import { describe, expect, it } from "vitest"
import { isHideUiChord } from "../src/content/core/hotkeys"

const chord = (over: Partial<Parameters<typeof isHideUiChord>[0]> = {}) => ({
  altKey: true,
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  code: "KeyH",
  ...over,
})

describe("isHideUiChord", () => {
  it("matches Alt+Shift+H", () => {
    expect(isHideUiChord(chord())).toBe(true)
  })

  it("ignores the key without both Alt and Shift", () => {
    expect(isHideUiChord(chord({ altKey: false }))).toBe(false)
    expect(isHideUiChord(chord({ shiftKey: false }))).toBe(false)
  })

  it("ignores it when Ctrl or Meta is also held (avoids browser/OS chords)", () => {
    expect(isHideUiChord(chord({ ctrlKey: true }))).toBe(false)
    expect(isHideUiChord(chord({ metaKey: true }))).toBe(false)
  })

  it("matches by physical key code, not the produced character", () => {
    // Alt+Shift can yield a different glyph in some layouts; key the chord off
    // the layout-independent code.
    expect(isHideUiChord(chord({ code: "KeyG" }))).toBe(false)
  })
})
