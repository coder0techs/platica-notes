import { describe, expect, it } from "vitest"
import {
  chatSpaceLink,
  isCreateTopicUrl,
  parseCreateTopicBody,
  parseCreateTopicResponse,
  parseOwnChatMessage,
} from "../src/content/chatgoogle/parse"

describe("chatSpaceLink", () => {
  it("derives the openable chat app link from the embed URL, dropping the rpctoken shell", () => {
    const embed =
      "https://chat.google.com/embed/space/AAQAllDeLzQ?shell=12&oi=1&rpctoken=36387733&parent=https%3A%2F%2Fmeet.google.com"
    expect(chatSpaceLink(embed)).toBe("https://chat.google.com/u/0/app/chat/AAQAllDeLzQ")
  })
  it("returns null when there is no space id", () => {
    expect(chatSpaceLink("https://chat.google.com/embed?shell=12")).toBeNull()
    expect(chatSpaceLink("https://example.com/x")).toBeNull()
  })
})

// The own-chat transport (verified against Google Meet's embedded Google Chat
// frame): sending a message is a POST to `.../api/create_topic` on the
// chat.google.com origin, the message text is field [1] of the JSON request
// body, and the response (a `)]}'`-guarded JSON array) carries the created
// topic id at [0][1][1]. These parsers isolate that wire shape so the frame
// hook stays trivial and the format is covered against hostile input.

describe("isCreateTopicUrl", () => {
  it("matches an absolute create_topic URL", () => {
    expect(isCreateTopicUrl("https://chat.google.com/u/0/api/create_topic")).toBe(true)
  })

  it("matches a relative create_topic path against the chat origin", () => {
    expect(isCreateTopicUrl("/api/create_topic")).toBe(true)
  })

  it("ignores query strings after the path", () => {
    expect(isCreateTopicUrl("https://chat.google.com/api/create_topic?alt=json")).toBe(true)
  })

  it("does not match other endpoints", () => {
    expect(isCreateTopicUrl("https://chat.google.com/api/get_topics")).toBe(false)
    expect(isCreateTopicUrl("/api/create_topic_extra")).toBe(false)
    expect(isCreateTopicUrl("/api/create_topics")).toBe(false)
  })

  it("does not throw on a malformed URL", () => {
    expect(isCreateTopicUrl("::::")).toBe(false)
  })
})

describe("parseCreateTopicBody", () => {
  it("extracts the message text from field [1]", () => {
    expect(parseCreateTopicBody(JSON.stringify([null, "buenos días", 12345]))).toBe("buenos días")
  })

  it("returns text verbatim (no trimming of inner content)", () => {
    expect(parseCreateTopicBody(JSON.stringify([0, "  hello world  "]))).toBe("  hello world  ")
  })

  it("returns null when field [1] is only whitespace", () => {
    expect(parseCreateTopicBody(JSON.stringify([0, "   "]))).toBeNull()
  })

  it("returns null when field [1] is not a string", () => {
    expect(parseCreateTopicBody(JSON.stringify([0, 42]))).toBeNull()
    expect(parseCreateTopicBody(JSON.stringify([0, null]))).toBeNull()
  })

  it("returns null when the body is not a JSON array", () => {
    expect(parseCreateTopicBody(JSON.stringify({ text: "hi" }))).toBeNull()
    expect(parseCreateTopicBody("not json at all")).toBeNull()
    expect(parseCreateTopicBody("")).toBeNull()
  })
})

describe("parseCreateTopicResponse", () => {
  it("returns the topic id, stripping the )]}' guard", () => {
    const body = ")]}'\n" + JSON.stringify([[null, ["ignored", "987654321"]]])
    expect(parseCreateTopicResponse(body)).toBe("987654321")
  })

  it("parses a plain (unguarded) JSON response", () => {
    expect(parseCreateTopicResponse(JSON.stringify([[null, ["x", "42"]]]))).toBe("42")
  })

  it("returns null when the id is not a digit string", () => {
    expect(parseCreateTopicResponse(JSON.stringify([[null, ["x", "abc"]]]))).toBeNull()
    expect(parseCreateTopicResponse(JSON.stringify([[null, ["x", 42]]]))).toBeNull()
  })

  it("returns null on a shape that lacks the id path", () => {
    expect(parseCreateTopicResponse(JSON.stringify([[null, "flat"]]))).toBeNull()
    expect(parseCreateTopicResponse(JSON.stringify([]))).toBeNull()
    expect(parseCreateTopicResponse(")]}'garbage")).toBeNull()
  })
})

describe("parseOwnChatMessage", () => {
  it("accepts a well-formed captured-chat payload", () => {
    expect(
      parseOwnChatMessage({ source: "platica-chatgoogle", text: "hi there", messageId: "987654321" }),
    ).toEqual({ text: "hi there", messageId: "987654321" })
  })

  it("accepts a payload without a message id", () => {
    expect(parseOwnChatMessage({ source: "platica-chatgoogle", text: "hi" })).toEqual({
      text: "hi",
      messageId: undefined,
    })
  })

  it("rejects a payload from another source tag", () => {
    expect(parseOwnChatMessage({ source: "something-else", text: "hi" })).toBeNull()
  })

  it("rejects a payload with no/blank text", () => {
    expect(parseOwnChatMessage({ source: "platica-chatgoogle", text: "" })).toBeNull()
    expect(parseOwnChatMessage({ source: "platica-chatgoogle", text: "   " })).toBeNull()
    expect(parseOwnChatMessage({ source: "platica-chatgoogle" })).toBeNull()
  })

  it("rejects non-object payloads", () => {
    expect(parseOwnChatMessage(null)).toBeNull()
    expect(parseOwnChatMessage("platica-chatgoogle")).toBeNull()
    expect(parseOwnChatMessage(42)).toBeNull()
  })
})
