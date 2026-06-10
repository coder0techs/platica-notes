import { describe, expect, it } from "vitest"
import { withDefaults } from "../src/shared/storage"
import { DEFAULT_SETTINGS } from "../src/shared/types"

describe("withDefaults", () => {
  it("returns defaults when nothing is stored", () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it("overlays stored values on defaults", () => {
    const settings = withDefaults({ retentionLimit: 5 })
    expect(settings.retentionLimit).toBe(5)
    expect(settings.hideCaptionsOverlay).toBe(DEFAULT_SETTINGS.hideCaptionsOverlay)
  })
})
