export type BackgroundRequest =
  | { kind: "getTabId" }
  | { kind: "meetingStarted" }
  | { kind: "meetingEnded" }
  | { kind: "downloadMeeting"; meetingId: string }
  | { kind: "deleteMeeting"; meetingId: string }
  | { kind: "uploadMeetingToDrive"; meetingId: string }
  | { kind: "connectDrive" }

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export function sendToBackground<T = unknown>(
  request: BackgroundRequest,
): Promise<BackgroundResponse<T>> {
  return chrome.runtime.sendMessage(request)
}
