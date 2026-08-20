import { describe, expect, it } from "vitest"
import { linkify, safeHref, type Segment } from "../src/content/core/linkify"

const text = (segments: Segment[]) => segments.map((s) => s.value).join("")
const links = (segments: Segment[]) => segments.filter((s) => s.kind === "link")

describe("linkify", () => {
  it("leaves text with no link as a single run", () => {
    expect(linkify("just a sentence")).toEqual([{ kind: "text", value: "just a sentence" }])
  })

  it("returns nothing for empty text", () => {
    expect(linkify("")).toEqual([])
  })

  it("finds a link on its own", () => {
    expect(linkify("https://example.com/a")).toEqual([
      { kind: "link", value: "https://example.com/a", href: "https://example.com/a" },
    ])
  })

  it("splits a link out of the surrounding sentence", () => {
    const segments = linkify("see https://example.com/a for the notes")
    expect(segments.map((s) => s.kind)).toEqual(["text", "link", "text"])
    expect(links(segments)[0].value).toBe("https://example.com/a")
  })

  it("finds several links in one message", () => {
    const segments = linkify("http://a.test/1 and https://b.test/2 and https://c.test/3")
    expect(links(segments).map((s) => s.value)).toEqual([
      "http://a.test/1",
      "https://b.test/2",
      "https://c.test/3",
    ])
  })

  it("never loses or duplicates a character", () => {
    // Concatenating the segments must reproduce the input: the panel renders
    // every segment, so anything dropped here is text the user typed and cannot
    // see, and anything duplicated is a message that reads wrong.
    for (const input of [
      "",
      "no links here",
      "https://example.com",
      "a https://example.com b",
      "https://a.test/1 https://b.test/2",
      "trailing https://example.com/x.",
      "(https://example.com/x)",
      "ссылка https://пример.рф/страница вот",
    ]) {
      expect(text(linkify(input))).toBe(input)
    }
  })

  describe("trailing punctuation", () => {
    it("leaves a full stop to the sentence", () => {
      expect(links(linkify("see https://example.com/x."))[0].value).toBe("https://example.com/x")
    })

    it("leaves a comma, semicolon, colon, question and exclamation mark too", () => {
      for (const mark of [",", ";", ":", "?", "!", "…"]) {
        expect(links(linkify(`x https://example.com/a${mark} y`))[0].value).toBe("https://example.com/a")
      }
    })

    it("strips a run of punctuation, not just the last character", () => {
      expect(links(linkify("really?! https://example.com/a?!.."))[0].value).toBe("https://example.com/a")
    })

    it("keeps a closing bracket the URL itself opened", () => {
      const url = "https://en.wikipedia.org/wiki/Foo_(bar)"
      expect(links(linkify(`see ${url} ok`))[0].value).toBe(url)
    })

    it("drops a closing bracket that belongs to the prose", () => {
      const segments = linkify("(see https://example.com/x)")
      expect(links(segments)[0].value).toBe("https://example.com/x")
      expect(text(segments)).toBe("(see https://example.com/x)")
    })

    it("keeps a query string and fragment intact", () => {
      const url = "https://example.com/search?q=a+b&n=1#results"
      expect(links(linkify(url))[0].value).toBe(url)
    })
  })

  describe("what must never become a link", () => {
    it("ignores javascript:", () => {
      // eslint-disable-next-line no-script-url
      const segments = linkify("javascript:alert(1)")
      expect(links(segments)).toHaveLength(0)
      expect(text(segments)).toBe("javascript:alert(1)")
    })

    it("ignores data:, file: and vbscript:", () => {
      for (const input of ["data:text/html,<script>x</script>", "file:///etc/passwd", "vbscript:msgbox"]) {
        expect(links(linkify(input))).toHaveLength(0)
      }
    })

    it("ignores a bare domain with no scheme", () => {
      // Guessing a scheme for "example.com" means guessing http for something a
      // user never asked to be a link.
      expect(links(linkify("go to example.com or www.example.com"))).toHaveLength(0)
    })

    it("ignores mailto:", () => {
      expect(links(linkify("write to mailto:someone@example.com"))).toHaveLength(0)
    })

    it("does not treat http inside a word as a link", () => {
      expect(links(linkify("xhttps://example.com"))).toHaveLength(1)
      // The match starts at the scheme, so the leading letter stays as text.
      expect(text(linkify("xhttps://example.com"))).toBe("xhttps://example.com")
    })
  })

  describe("href", () => {
    it("is the parsed absolute form, not the raw text", () => {
      expect(links(linkify("HTTPS://Example.COM/Path"))[0].href).toBe("https://example.com/Path")
    })

    it("keeps the visible text as typed even when the href is normalised", () => {
      expect(links(linkify("HTTPS://Example.COM/Path"))[0].value).toBe("HTTPS://Example.COM/Path")
    })
  })
})

describe("safeHref", () => {
  it("accepts http and https", () => {
    expect(safeHref("http://a.test")).toBe("http://a.test/")
    expect(safeHref("https://a.test")).toBe("https://a.test/")
  })

  it("rejects every other scheme", () => {
    for (const input of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "chrome-extension://abc/page.html",
      "mailto:a@b.test",
      "not a url",
      "",
    ]) {
      expect(safeHref(input)).toBeNull()
    }
  })
})
