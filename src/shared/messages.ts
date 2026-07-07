export type BackgroundRequest =
  | { kind: "getTabId" }
  | { kind: "meetingStarted" }
  | { kind: "meetingEnded" }
  | { kind: "downloadMeeting"; meetingId: string }
  | { kind: "deleteMeeting"; meetingId: string }

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  // `invalidated` is set when the failure is an orphaned extension context (the
  // extension was reloaded/updated while this content script kept running), so
  // callers can surface a reload notice instead of retrying a dead channel.
  | { ok: false; error: string; invalidated?: boolean }

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
