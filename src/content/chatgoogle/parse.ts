// Pure parsers for Google Meet's in-meeting chat, which now rides an embedded
// Google Chat frame (chat.google.com) instead of the old `meet_messages` data
// channel. The local user's OWN outgoing message never comes back over the
// meeting page's WebRTC channels, so it can only be observed at send time inside
// that cross-origin frame: it is a POST to `.../api/create_topic` whose JSON
// request body carries the text at field [1], and whose `)]}'`-guarded JSON
// response carries the created topic id at [0][1][1].
//
// Clean reimplementation against the observable request/response shape; only the
// public wire format is used. No DOM/chrome/window dependencies so it is fully
// unit-testable.

// True when `url` (absolute or relative) targets the create_topic endpoint.
// Relative URLs resolve against the chat origin (the frame's own origin at
// runtime); tolerates a malformed URL by returning false rather than throwing.
export function isCreateTopicUrl(url: string, base = "https://chat.google.com"): boolean {
  try {
    return new URL(url, base).pathname.endsWith("/api/create_topic")
  } catch {
    return false
  }
}

// The outgoing message text is field [1] of the JSON request-body array. Text is
// returned verbatim (Meet preserves leading/trailing spaces the user typed); a
// value that is absent, non-string, or only whitespace yields null.
export function parseCreateTopicBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed) && typeof parsed[1] === "string" && parsed[1].trim()) return parsed[1]
  } catch {
    /* not a JSON body we recognize */
  }
  return null
}

// The response is a JSON array, optionally guarded by a leading `)]}'` line. The
// created topic id lives at [0][1][1] and is a decimal string; anything else
// yields null (used only as a stable dedupe key, so a miss is harmless).
export function parseCreateTopicResponse(text: string): string | null {
  try {
    let body = text
    if (body.startsWith(")]}'")) body = body.substring(4).trim()
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed) && Array.isArray(parsed[0]) && Array.isArray(parsed[0][1])) {
      const id = parsed[0][1][1]
      if (typeof id === "string" && /^\d+$/.test(id)) return id
    }
  } catch {
    /* not a create_topic response */
  }
  return null
}

// The in-meeting chat frame loads an EMBED URL — a gapi shell like
// `https://chat.google.com/embed/space/<spaceId>?shell=…&rpctoken=…` — which carries
// a per-load rpctoken and is not a shareable link. Extract just the space id and
// return the canonical room URL `https://chat.google.com/room/<spaceId>`, so the
// saved header holds a clean, token-free, openable link (and a usable space id for
// the Google Chat API / MCP). Returns null when no space id is present.
export function chatSpaceLink(url: string): string | null {
  const m = /\/space\/([A-Za-z0-9_-]+)/.exec(url)
  return m ? `https://chat.google.com/room/${m[1]}` : null
}

// Validate and normalize a cross-frame postMessage payload dispatched by the
// chat-frame hook (see main.ts). The window "message" listener still checks the
// event ORIGIN (only the chat frame may send these); this covers the payload
// shape. Returns the text + optional dedupe id, or null when the payload is not
// a well-formed capture with non-blank text.
export function parseOwnChatMessage(data: unknown): { text: string; messageId?: string } | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  if (d.source !== "platica-chatgoogle") return null
  if (typeof d.text !== "string" || !d.text.trim()) return null
  return { text: d.text, messageId: typeof d.messageId === "string" ? d.messageId : undefined }
}
