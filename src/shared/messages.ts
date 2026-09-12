export type BackgroundRequest =
  | { kind: "getTabId" }
  // Asks for the capability token this tab's MAIN world may later use to persist
  // a snapshot over the external channel. Sent once per meeting, over the trusted
  // internal channel, BEFORE any update can orphan this content script. The token
  // is minted and stored by the background and returned here: the secret is made
  // where it is checked, so a compromised page context cannot weaken it.
  | { kind: "registerRelayToken" }
  | { kind: "meetingStarted" }
  | { kind: "meetingEnded" }
  | { kind: "downloadMeeting"; meetingId: string }
  | { kind: "downloadLiteLog"; meetingId: string }
  | { kind: "deleteMeeting"; meetingId: string }

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  // `invalidated` is set when the failure is an orphaned extension context (the
  // extension was reloaded/updated while this content script kept running), so
  // callers can surface a reload notice instead of retrying a dead channel.
  | { ok: false; error: string; invalidated?: boolean }

/**
 * A session snapshot arriving over `externally_connectable` from the MAIN world,
 * used only after this tab's content script has been orphaned by an update.
 *
 * SECURITY. The external channel is open to every script on the meeting page, so
 * a message arriving here is NOT trusted by virtue of arriving. Two things gate
 * it: the sender's origin, and `token`, which the trusted content script minted
 * and registered over the internal channel while it was still alive. Without a
 * matching token the snapshot is dropped, which is what keeps another extension's
 * page script (or Meet's own code) from writing sessions into our storage.
 *
 * This does not widen the trust boundary around the transcript itself: the
 * captions already come from that page's script context via the MAIN-world hook.
 */
export interface RelaySnapshotMessage {
  kind: "relaySnapshot"
  token: string
  tabId: number
  snapshot: unknown
  /**
   * The meeting is over: persist this snapshot, then finalize it exactly as
   * `meetingEnded` would. Without it an update mid-meeting would still cost the
   * user the normal ending — the file would only appear when the tab closed.
   */
  final?: boolean
}

/** Narrow an unknown external message to a relay snapshot. Shape only, no trust. */
export function isRelaySnapshotMessage(value: unknown): value is RelaySnapshotMessage {
  const m = value as Partial<RelaySnapshotMessage> | null
  return (
    typeof m === "object" &&
    m !== null &&
    m.kind === "relaySnapshot" &&
    typeof m.token === "string" &&
    m.token.length > 0 &&
    typeof m.tabId === "number" &&
    Number.isInteger(m.tabId) &&
    m.snapshot !== undefined &&
    (m.final === undefined || typeof m.final === "boolean")
  )
}

// Substrings Chrome uses when a content script's runtime is gone: the context was
// torn down by a reload/update, or the message channel/receiving end died with it.
// Matched case-insensitively against the error message.
const INVALIDATED_MARKERS = [
  "extension context invalidated",
  "message channel closed before a response was received",
  "receiving end does not exist",
]

/** True when `error` signals an orphaned extension context (see INVALIDATED_MARKERS). */
export function isContextInvalidatedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown } | null)?.message === "string"
          ? (error as { message: string }).message
          : ""
  const lower = message.toLowerCase()
  return INVALIDATED_MARKERS.some((marker) => lower.includes(marker))
}

export async function sendToBackground<T = unknown>(
  request: BackgroundRequest,
): Promise<BackgroundResponse<T>> {
  try {
    return await chrome.runtime.sendMessage(request)
  } catch (error) {
    // Never let a dead-channel reject escape as an unhandled rejection. Report it
    // as a failed response so the caller decides what to do; flag context loss so
    // it can show the reload notice.
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message, invalidated: isContextInvalidatedError(error) }
  }
}
