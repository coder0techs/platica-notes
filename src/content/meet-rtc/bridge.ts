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
  langId?: number
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
}

export interface RtcDeviceEvent {
  type: "device"
  deviceId: string
  deviceName: string
}

export type RtcEvent = RtcCaptionEvent | RtcChatEvent | RtcDeviceEvent

export interface RtcConfig {
  captionLanguage: string
  debug: boolean
}
