import { describe, expect, it } from "vitest"
import { hasActiveMeeting, withDefaults } from "../src/shared/storage"
import { DEFAULT_SETTINGS } from "../src/shared/types"

describe("withDefaults", () => {
  it("returns defaults when nothing is stored", () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it("overlays stored values on defaults", () => {
    const settings = withDefaults({ retentionLimit: 5 })
    expect(settings.retentionLimit).toBe(5)
    expect(settings.captionLanguage).toBe(DEFAULT_SETTINGS.captionLanguage)
  })
})

describe("captionAlternatives default", () => {
  it("defaults caption alternatives on", () => {
    expect(DEFAULT_SETTINGS.captionAlternatives).toBe(true)
  })
})

describe("default caption language", () => {
  it("defaults a fresh install to English", () => {
    // The store audience is international; the user's own install can override
    // this from the popup. Russian was the pre-1.x default.
    expect(DEFAULT_SETTINGS.captionLanguage).toBe("en-US")
  })

  it("preserves an existing user's stored language (upgrade migration)", () => {
    // withDefaults overlays stored over defaults, so a user who had picked
    // Russian keeps it after the default flips to English — no silent reset.
    expect(withDefaults({ captionLanguage: "es-MX" }).captionLanguage).toBe("es-MX")
  })
})

describe("hide-UI setting", () => {
  it("shows the UI by default", () => {
    expect(DEFAULT_SETTINGS.hideUi).toBe(false)
  })
})

describe("hasActiveMeeting (settings active-meeting note)", () => {
  it("is false when nothing is recording", () => {
    expect(hasActiveMeeting(undefined)).toBe(false)
    expect(hasActiveMeeting([])).toBe(false)
  })

  it("is true when one or more tabs are recording", () => {
    expect(hasActiveMeeting([7])).toBe(true)
    expect(hasActiveMeeting([7, 12])).toBe(true)
  })
})
