// Accepting a session snapshot from the meeting page, when the content script
// that would normally have written it has been orphaned by an update.
//
// The channel this arrives on (externally_connectable) is open to EVERY script on
// the meeting page: Meet's own code, and any other extension's page script. So
// nothing here is trusted for arriving. Three things gate a write, and all of them
// have to hold:
//
//   1. the sender's origin is the meeting host, exactly;
//   2. the sender's real tab, as Chrome reports it, is the tab whose session the
//      message claims to be writing - a script in one tab can never write
//      another tab's session, whatever it puts in the payload;
//   3. the token matches the one the trusted content script minted for that tab
//      and registered over the internal channel while it was still alive.
//
// (2) is the strong one and (3) survives a tab id being reused. Neither widens
// the trust boundary around the transcript itself: the captions already come from
// that page's script context through the MAIN-world hook, so a hostile
// meet.google.com could always have fed us fiction. What this keeps out is a
// neighbouring extension writing into our storage.

import { isRelaySnapshotMessage, type RelaySnapshotMessage } from "../shared/messages"

/** Where relay tokens live. Must outlive both a service-worker restart and an update. */
export const RELAY_TOKENS_KEY = "relayTokens"

export type RelayTokens = Record<string, string>

/** The one origin allowed to relay. Meeting pages only; the chat frame never relays. */
export const RELAY_ORIGIN = "https://meet.google.com"

/** What Chrome tells us about an external sender, narrowed to what is checked. */
export interface RelaySender {
  origin?: string
  tab?: { id?: number }
}

export type RelayVerdict =
  | { accept: true; tabId: number; snapshot: unknown; final: boolean }
  | { accept: false; reason: string }

/**
 * Decide whether a message may write a session. Pure: no chrome.*, no storage, so
 * every rejection path is testable without a browser.
 */
export function verifyRelay(
  message: unknown,
  sender: RelaySender | undefined,
  tokens: RelayTokens,
): RelayVerdict {
  if (!isRelaySnapshotMessage(message)) return { accept: false, reason: "not a relay message" }
  const relay: RelaySnapshotMessage = message
  if (sender?.origin !== RELAY_ORIGIN) return { accept: false, reason: `origin ${sender?.origin ?? "none"}` }
  const senderTab = sender.tab?.id
  if (typeof senderTab !== "number") return { accept: false, reason: "sender has no tab" }
  if (senderTab !== relay.tabId) {
    // A page script claiming another tab's session. Never legitimate.
    return { accept: false, reason: `tab mismatch: sender ${senderTab}, claimed ${relay.tabId}` }
  }
  const expected = tokens[String(relay.tabId)]
  if (!expected) return { accept: false, reason: "no token registered for tab" }
  if (expected !== relay.token) return { accept: false, reason: "token mismatch" }
  return { accept: true, tabId: relay.tabId, snapshot: relay.snapshot, final: relay.final === true }
}

/** A token to hand the MAIN world. Unguessable, and worthless outside its tab. */
export function mintRelayToken(randomValues: Uint8Array): string {
  return Array.from(randomValues, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Registering a tab's token, and forgetting it when the meeting is over. */
export function withToken(tokens: RelayTokens, tabId: number, token: string): RelayTokens {
  return { ...tokens, [String(tabId)]: token }
}

export function withoutToken(tokens: RelayTokens, tabId: number): RelayTokens {
  const next = { ...tokens }
  delete next[String(tabId)]
  return next
}
