import { describe, expect, it } from "vitest"
import { isContextInvalidatedError } from "../src/shared/messages"

describe("isContextInvalidatedError", () => {
  it("matches the orphaned-context error", () => {
    expect(isContextInvalidatedError(new Error("Extension context invalidated."))).toBe(true)
  })

  it("matches the closed-message-channel reject", () => {
    expect(
      isContextInvalidatedError(new Error("message channel closed before a response was received")),
    ).toBe(true)
  })

  it("matches the no-receiving-end reject", () => {
    expect(
      isContextInvalidatedError(
        new Error("Could not establish connection. Receiving end does not exist."),
      ),
    ).toBe(true)
  })

  it("is case-insensitive and matches when the phrase is embedded", () => {
    expect(isContextInvalidatedError(new Error("Uncaught: EXTENSION CONTEXT INVALIDATED"))).toBe(true)
  })

  it("accepts a bare string error", () => {
    expect(isContextInvalidatedError("Extension context invalidated.")).toBe(true)
  })

  it("accepts a message-bearing object (chrome.runtime.lastError shape)", () => {
    expect(isContextInvalidatedError({ message: "Extension context invalidated" })).toBe(true)
  })

  it("returns false for an unrelated error", () => {
    expect(isContextInvalidatedError(new Error("QUOTA_BYTES quota exceeded"))).toBe(false)
  })

  it("returns false for non-error values", () => {
    expect(isContextInvalidatedError(null)).toBe(false)
    expect(isContextInvalidatedError(undefined)).toBe(false)
    expect(isContextInvalidatedError(42)).toBe(false)
    expect(isContextInvalidatedError({ code: "ERR" })).toBe(false)
  })
})
