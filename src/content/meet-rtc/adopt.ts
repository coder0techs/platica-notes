// Attaching to a peer connection without owning the global constructor.
//
// The obvious way to see Meet's data channels is to wrap
// `window.RTCPeerConnection` and listen for `datachannel` on every connection it
// builds. That works right up until another extension wraps the same global
// after we do: Meet then constructs through theirs, ours never runs, our
// listener is never attached, and every remotely-opened channel — including
// `media-session`, the one the caption subscription rides on — is invisible to
// us. Measured on a real meeting: zero caption frames on the wire across 88
// seconds, because we never got as far as subscribing.
//
// Winning that race is not possible and not worth wanting: injection order
// between two extensions is the browser's to decide, and whoever assigns last
// wins, so "winning" would mean breaking a tool the user chose to install.
//
// The way out is to stop needing the constructor. The prototype is untouched by
// the extension we conflict with, and every prototype method receives the live
// connection as `this` — so the first time Meet calls any of them, we take the
// connection we were handed and attach the listener there. Same listener, same
// events, obtained through a door nobody is standing in.

/** Minimal shape used here, so a test can pass a fake instead of a real connection. */
export interface AdoptablePeerConnection {
  addEventListener(type: string, listener: (event: { channel: unknown }) => void): void
}

/**
 * Attach `onChannel` to this connection's `datachannel` event, once.
 *
 * Idempotent per connection: every prototype hook calls this, and Meet calls
 * several of them on the same connection. A `WeakSet` keyed on the connection
 * both dedupes and lets it be collected with the call.
 *
 * @returns true if this call is the one that attached
 */
export function adoptPeerConnection<T extends AdoptablePeerConnection>(
  pc: T,
  seen: WeakSet<AdoptablePeerConnection>,
  onChannel: (channel: unknown, pc: T) => void,
): boolean {
  if (seen.has(pc)) return false
  seen.add(pc)
  pc.addEventListener("datachannel", (event) => {
    // Never throw into Meet's own event dispatch.
    try {
      onChannel(event.channel, pc)
    } catch {
      /* a diagnostic or routing failure must not break the call */
    }
  })
  return true
}
