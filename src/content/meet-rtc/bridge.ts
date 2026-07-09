// Shared contract between the MAIN-world capture script (main.ts) and the
// isolated-world Meet adapter. Imported by both bundles — esbuild bundles each
// entry separately, so the constants are simply duplicated into each output.

// CustomEvent name dispatched by the MAIN-world script on `document`.
// `detail` is a JSON STRING of RtcEvent: plain objects do NOT cross Chrome's
// isolated-world boundary (each world has its own JS heap, and non-primitive
// detail values arrive as null on the other side), so we serialize.
export const RTC_EVENT = "platica-rtc"

// CustomEvent name dispatched by the isolated-world adapter on `document`.
// `detail` is a JSON string of RtcConfig (same boundary constraint).
export const RTC_CONFIG_EVENT = "platica-rtc-config"

// MAIN-world script dispatches these (detail = JSON string of a DebugEvent with ctx:"rtc")
// only when debug is enabled; isolated adapter collects them.
export const RTC_DEBUG_EVENT = "platica-rtc-debug"

// Events for one channel are emitted in arrival order, but consumers must
// still treat max(messageVersion) per (deviceId, messageId) as the winner
// regardless of arrival order.
export interface RtcCaptionEvent {
  type: "transcript"
  deviceId: string
  messageId: number
  messageVersion: number
  text: string
}

// No timestamp here: Meet's wire timestamp unit is unverified, so the adapter
// stamps receive time instead of trusting the wire value.
// sender is the display name embedded in the chat packet (message.f8.f1); optional
// because the live diagnostic logger truncates packets before f8.
export interface RtcChatEvent {
  type: "chat"
  deviceId: string
  text: string
  sender?: string
  // Stable message resource name ("spaces/…/messages/…") from the collections
  // channel. The feed dedupes on it: that channel re-syncs messages, so the same
  // one can arrive in more than one packet. Absent for messages without an id.
  messageId?: string
}

export interface RtcDeviceEvent {
  type: "device"
  deviceId: string
  deviceName: string
}

// A participant left: the collections channel removed their device (bare deviceId,
// no name — see decodeRosterLeave). The adapter maps the id back to the name it
// already learned and emits a "leave" marker.
export interface RtcDeviceLeaveEvent {
  type: "device-leave"
  deviceId: string
  // Present when the leave came from a roster state-6 leaf (which still carries the
  // name); lets the adapter resolve the name even if it wasn't rostered before.
  deviceName?: string
}

// The local user's own display name, parsed from the GetUser RPC; the adapter
// binds it to unresolved (non-roster) speakers — Meet never rosters self.
export interface RtcSelfEvent {
  type: "self"
  name: string
}

// Liveness of the call's media path: the count of open media-session data
// channels (one per peer connection) after the latest open/close, plus that
// connection's state. Carries no transcript content. The adapter treats a
// sustained zero as the authoritative meeting-end signal (see meet-lifecycle).
export interface RtcMediaEvent {
  type: "media"
  openSessions: number
  pcState: RTCPeerConnectionState
}

export type RtcEvent =
  | RtcCaptionEvent
  | RtcChatEvent
  | RtcDeviceEvent
  | RtcDeviceLeaveEvent
  | RtcSelfEvent
  | RtcMediaEvent

export interface RtcConfig {
  captionLanguage: string
  debug: boolean
}
