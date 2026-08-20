// Split chat text into plain runs and the links inside it, so the panel can
// render an anchor per link without ever going near innerHTML.
//
// Pure and DOM-free on purpose: the rendering side only has to walk the result
// and call createElement/createTextNode, which keeps the "untrusted strings
// reach the DOM through textContent only" invariant trivially true.

export type Segment = { kind: "text"; value: string } | { kind: "link"; value: string; href: string }

// Only http(s). A chat message is untrusted text, and a javascript:, data: or
// vbscript: href in a panel rendered inside the meeting page would be a script
// injection with extra steps.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi

// Sentence punctuation that a human types after a link, not part of it. Closing
// brackets are handled separately: they belong to the URL when it opened them.
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "…"])
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

/**
 * Trim punctuation that ends the sentence rather than the URL.
 *
 * "see https://example.com/x." should not link the full stop, but
 * "https://en.wikipedia.org/wiki/Foo_(bar)" keeps its closing bracket because
 * the URL opened it.
 */
function trimTrailing(candidate: string): string {
  let end = candidate.length
  while (end > 0) {
    const char = candidate[end - 1]
    if (TRAILING.has(char)) {
      end -= 1
      continue
    }
    const opener = CLOSERS[char]
    if (opener) {
      const inner = candidate.slice(0, end)
      const opened = inner.split(opener).length - 1
      const closed = inner.split(char).length - 1
      // Unbalanced: this closer belongs to the surrounding prose.
      if (closed > opened) {
        end -= 1
        continue
      }
    }
    break
  }
  return candidate.slice(0, end)
}

/** The absolute http(s) URL this text really is, or null if it is not one. */
export function safeHref(candidate: string): string | null {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  return url.href
}

/**
 * Break text into plain runs and links, in order. Concatenating every segment's
 * `value` reproduces the input exactly, so nothing can be lost or duplicated by
 * the rendering that follows.
 */
export function linkify(text: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index
    const raw = match[0]
    const trimmed = trimTrailing(raw)
    const href = safeHref(trimmed)
    // Not a usable URL after all — leave it as text and move past it.
    if (!href || trimmed === "") continue

    if (start > cursor) segments.push({ kind: "text", value: text.slice(cursor, start) })
    segments.push({ kind: "link", value: trimmed, href })
    cursor = start + trimmed.length
  }

  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) })
  return segments
}
