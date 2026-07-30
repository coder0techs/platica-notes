// Shared contract between a MAIN-world capture script (capture/<platform>/main.ts)
// and its isolated-world adapter. Imported by both bundles — esbuild bundles each
// entry separately, so the constants are simply duplicated into each output.

// CustomEvent name dispatched by the MAIN-world script on `document`.
// `detail` is a JSON STRING of CaptureEvent: plain objects do NOT cross Chrome's
// isolated-world boundary (each world has its own JS heap, and non-primitive
// detail values arrive as null on the other side), so we serialize.
export const RTC_EVENT = "platica-rtc"

// CustomEvent name dispatched by the isolated-world adapter on `document`.
// `detail` is a JSON string of CaptureConfig (same boundary constraint).
export const RTC_CONFIG_EVENT = "platica-rtc-config"

// MAIN-world script dispatches these (detail = JSON string of a DebugEvent with
// ctx:"rtc") only when debug is enabled; the isolated adapter collects them.
export const RTC_DEBUG_EVENT = "platica-rtc-debug"

/**
 * One revision of a spoken turn.
 *
 * TWO INVARIANTS EVERY PLATFORM MUST HONOUR, because the core loses text silently
 * if either is broken:
 *
 * 1. `text` is the CUMULATIVE text of this utterance so far, never a delta. The
 *    feed strips the already-emitted prefix itself (see suffixAfter).
 * 2. `revision` strictly increases within one `utteranceId`. The feed drops any
 *    revision <= the one it already holds. Meet reads it off the wire; a platform
 *    with no version field (Zoom) must keep its own per-utterance counter. Do NOT
 *    use Date.now() for that: two revisions inside one millisecond would collide
 *    and the second would be dropped.
 *
 * Events for one channel are emitted in arrival order, but consumers must still
 * treat max(revision) per (speakerId, utteranceId) as the winner regardless of
 * arrival order.
 */
export interface UtteranceEvent {
  type: "utterance"
  speakerId: string
  utteranceId: string
  revision: number
  text: string
}

// No timestamp here: a platform's wire timestamp unit is rarely verifiable (Meet's
// is unverified), so the adapter stamps receive time instead of trusting the wire
// value. `sender` is the display name embedded in the chat packet when the platform
// ships one (Meet: message.f8.f1); optional because Meet's live diagnostic logger
// truncates packets before it.
export interface ChatEvent {
  type: "chat"
  speakerId: string
  text: string
  sender?: string
  // Stable platform message id, when there is one (Meet: the "spaces/…/messages/…"
  // resource name). The feed dedupes on it: a re-syncing channel can deliver the
  // same message in more than one packet. Absent for messages without an id.
  messageId?: string
}

// A participant is present in the platform's roster. Named "roster" rather than
// "participant" so it cannot be confused with shared/types.ts's ParticipantEvent,
// which is the join/leave marker that reaches the saved file.
export interface RosterEvent {
  type: "roster"
  speakerId: string
  name: string
}

// A participant left: the platform removed their roster entry (Meet: a bare
// deviceId — see decodeRosterLeave). `name` is present when the removal packet
// still carries it (Meet's roster state-6 leaf does), which lets the adapter
// resolve the name even for a speaker it never saw present.
export interface RosterLeaveEvent {
  type: "roster-leave"
  speakerId: string
  name?: string
}

// The local user's own display name (Meet: parsed from the GetUser RPC). Meet never
// rosters self, so the adapter binds this to otherwise-unresolved speakers.
export interface SelfEvent {
  type: "self"
  name: string
}

// Liveness of the call's media path: the count of open media-session data channels
// (one per peer connection) after the latest open/close, plus that connection's
// state. Carries no transcript content. An adapter that declares
// capabilities.livenessEnd treats a sustained zero as the authoritative meeting-end
// signal (see meet-lifecycle).
export interface LivenessEvent {
  type: "liveness"
  openSessions: number
  pcState: RTCPeerConnectionState
}

export type CaptureEvent =
  | UtteranceEvent
  | ChatEvent
  | RosterEvent
  | RosterLeaveEvent
  | SelfEvent
  | LivenessEvent

export interface CaptureConfig {
  captionLanguage: string
  debug: boolean
}
