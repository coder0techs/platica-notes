import { describe, expect, it } from "vitest"
import {
  mintRelayToken,
  RELAY_ORIGIN,
  verifyRelay,
  withToken,
  withoutToken,
  type RelayTokens,
} from "../src/background/relay"

// The relay is the one door into this extension that anything on the meeting page
// can knock on, so every rejection path is a test. A hole here is not a lost
// feature, it is a neighbouring extension writing into a user's transcripts.

const TAB = 42
const TOKEN = "a".repeat(32)
const tokens: RelayTokens = { [String(TAB)]: TOKEN }

const message = (over: Record<string, unknown> = {}) => ({
  kind: "relaySnapshot",
  token: TOKEN,
  tabId: TAB,
  snapshot: { transcript: [] },
  ...over,
})

const sender = (over: Record<string, unknown> = {}) => ({
  origin: RELAY_ORIGIN,
  tab: { id: TAB },
  ...over,
})

describe("verifyRelay", () => {
  it("accepts a well-formed message from the right tab with the right token", () => {
    const verdict = verifyRelay(message(), sender(), tokens)
    expect(verdict).toEqual({ accept: true, tabId: TAB, snapshot: { transcript: [] }, final: false })
  })

  it("carries the final flag through, so a relayed meeting still ends normally", () => {
    const verdict = verifyRelay(message({ final: true }), sender(), tokens)
    expect(verdict.accept && verdict.final).toBe(true)
  })

  it("rejects anything that is not a relay message", () => {
    for (const bad of [null, undefined, 42, "relaySnapshot", {}, { kind: "getTabId" }]) {
      expect(verifyRelay(bad, sender(), tokens).accept).toBe(false)
    }
  })

  it("rejects a message whose shape is right but whose fields are not", () => {
    const bad = [
      { token: "" }, // empty token
      { token: 1 },
      { tabId: "42" },
      { tabId: 1.5 }, // tab ids are integers
      { snapshot: undefined },
      { final: "yes" },
    ]
    for (const over of bad) expect(verifyRelay(message(over), sender(), tokens).accept).toBe(false)
  })

  it("rejects any origin but the meeting host", () => {
    // Nothing here is subdomain- or prefix-matched: an attacker who can register
    // meet.google.com.evil.test must not get in on a startsWith().
    for (const origin of [
      undefined,
      "https://evil.test",
      "https://meet.google.com.evil.test",
      "http://meet.google.com",
      "https://chat.google.com",
      "https://docs.google.com",
    ]) {
      expect(verifyRelay(message(), sender({ origin }), tokens).accept).toBe(false)
    }
  })

  it("rejects a sender Chrome could not place in a tab", () => {
    expect(verifyRelay(message(), sender({ tab: undefined }), tokens).accept).toBe(false)
    expect(verifyRelay(message(), sender({ tab: {} }), tokens).accept).toBe(false)
    expect(verifyRelay(message(), undefined, tokens).accept).toBe(false)
  })

  it("refuses to let one tab write another tab's session", () => {
    // The strongest of the three gates: Chrome fills sender.tab itself, so a page
    // script cannot forge it however it dresses up the payload.
    const other = { ...tokens, "7": "b".repeat(32) }
    const verdict = verifyRelay(message({ tabId: 7, token: "b".repeat(32) }), sender(), other)
    expect(verdict.accept).toBe(false)
    expect(verdict.accept === false && verdict.reason).toContain("tab mismatch")
  })

  it("rejects a tab that never registered a token", () => {
    expect(verifyRelay(message(), sender(), {}).accept).toBe(false)
  })

  it("rejects a wrong token for a tab that has one", () => {
    // Covers tab-id reuse: a new tab landing on a recycled id still needs the
    // token minted for THIS meeting.
    expect(verifyRelay(message({ token: "c".repeat(32) }), sender(), tokens).accept).toBe(false)
  })
})

describe("relay tokens", () => {
  it("mints a hex token from the bytes given", () => {
    expect(mintRelayToken(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff")
  })

  it("mints something long enough not to be guessed", () => {
    const token = mintRelayToken(new Uint8Array(16))
    expect(token).toHaveLength(32)
  })

  it("adds and removes without mutating the map it was given", () => {
    const before: RelayTokens = { "1": "x" }
    const added = withToken(before, 2, "y")
    expect(before).toEqual({ "1": "x" })
    expect(added).toEqual({ "1": "x", "2": "y" })
    const removed = withoutToken(added, 1)
    expect(added).toEqual({ "1": "x", "2": "y" })
    expect(removed).toEqual({ "2": "y" })
  })

  it("re-registering a tab replaces its token rather than keeping both", () => {
    // A second meeting in the same tab must not leave the first meeting's token
    // usable: that would outlive the meeting it was minted for.
    expect(withToken({ "1": "old" }, 1, "new")).toEqual({ "1": "new" })
  })
})
