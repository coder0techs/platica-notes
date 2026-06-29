import { describe, expect, it } from "vitest"
import { shouldOpenWelcome } from "../src/background/install"

describe("shouldOpenWelcome (first-run welcome page)", () => {
  it("opens on a genuine install", () => {
    expect(shouldOpenWelcome("install")).toBe(true)
  })

  // An update must NOT reopen the welcome page or it would nag existing users and
  // could overwrite a default language they already set.
  it("does NOT open on update", () => {
    expect(shouldOpenWelcome("update")).toBe(false)
  })

  it("does NOT open on a browser or extension restart", () => {
    expect(shouldOpenWelcome("chrome_update")).toBe(false)
    expect(shouldOpenWelcome("shared_module_update")).toBe(false)
  })
})
