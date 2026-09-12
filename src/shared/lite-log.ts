// The lite diagnostic log: what every meeting keeps, including a private one.
//
// The full debug log is opt-in and holds the meeting verbatim, so it is absent
// exactly when something has gone wrong and nobody thought to turn it on first.
// That is how a caption-channel rename cost a user several days of empty files
// with no artefact to show for any of them. The lite log exists to be there
// already: enough to say what capture did, and not one word of what was said.
//
// Two independent filters, both defaulting to "exclude". A phase nobody has
// vetted is dropped; a string field nobody has vetted is replaced by its length.
// Getting either default the other way round leaks the first time someone adds
// an event without thinking about this file.

/** Events that describe what capture DID. Nothing here carries speech or chat. */
const ALLOWED_KINDS = new Set([
  // MAIN world: channels, subscription, health counters.
  "config",
  "installed",
  "channel",
  "frame-shape",
  "capture-state",
  "funnel",
  "subscribe-sent",
  "subscribe-error",
  "resubscribe-sent",
  "resubscribe-error",
  "captions-create",
  "create-captions-error",
  "captions-closed",
  "captions-recreate",
  "captions-channel-adopted",
  "media-session-open",
  "media-session-closed",
  "self-device",
  "pc-adopted",
  "decode-error",
  "dispatch-error",
  "unexpected-payload",
  // Isolated-world adapter and background: the meeting's own lifecycle.
  "meeting header",
  "capture armed",
  "capture health warning",
  "capture health warning retracted",
  "device seen",
  "device left",
  "captions are flowing",
  "meeting ended",
  "finalizing after caption flush",
  "resuming session after reload",
  "finalized",
  "finalized empty",
])

/**
 * String fields that may appear verbatim.
 *
 * Each is here because it names a mechanism rather than a person or a sentence:
 * channel labels, connection states, language tags, build ids, device ids (an
 * opaque `spaces/…/devices/N` path, which is what ties turns to speakers in a
 * diagnosis), and shapes, which are content-free by construction.
 */
const ALLOWED_STRINGS = new Set([
  "ctx",
  "phase",
  "msg",
  "t",
  "label",
  "reason",
  "state",
  "pc",
  "lang",
  "error",
  "deviceId",
  "parentDeviceId",
  "version",
  "commit",
  "meetBuild",
  "userAgent",
  "meetingPath",
  "where",
  "type",
  "fault",
  "shape",
])

/** String-array fields that may appear verbatim, same reasoning as above. */
const ALLOWED_STRING_ARRAYS = new Set(["channels", "adoptedVia", "sniffedCaptions"])

// Dropped rather than redacted. Not a safety measure (the default already
// covers these), but a redacted `hex: "<320 chars>"` is noise beside the `bytes`
// count that says the same thing, and `shape` is the field that replaced it.
const NOISE_KEYS = new Set(["hex"])

// Length rather than value. Says "a name was there and it was this long", which
// is occasionally useful in a diagnosis and never quotes anybody.
function redact(value: string): string {
  return `<${[...value].length} chars>`
}

/**
 * Reduce one diagnostic event to its content-free form, or drop it entirely.
 *
 * Returns null for an event whose whole purpose is to carry content (a caption,
 * a chat line, a raw RPC dump) and for any event this file has not been taught
 * about. The framing fields `t` and `ctx` are added by the caller, not here.
 */
export function toLiteEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  const kind = typeof event.phase === "string" ? event.phase : typeof event.msg === "string" ? event.msg : ""
  if (!ALLOWED_KINDS.has(kind)) return null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || value === null || NOISE_KEYS.has(key)) continue
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value
    } else if (typeof value === "string") {
      out[key] = ALLOWED_STRINGS.has(key) ? value : redact(value)
    } else if (Array.isArray(value) && ALLOWED_STRING_ARRAYS.has(key)) {
      out[key] = value.filter((v): v is string => typeof v === "string")
    }
    // Anything else, nested objects and unlisted arrays, is dropped. Walking an
    // object of unknown shape is exactly how content escapes a filter like this.
  }
  return out
}
