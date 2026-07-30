// Why capture is, or is not, producing anything. A pure fold: the runner holds the
// current value and feeds inputs in, so the whole state machine is unit-testable.
//
// The distinction that matters, and the reason this is not a simple timer: "the
// channel is open and nobody is talking" is NOT a fault. Alarming on the absence of
// speech (Tactiq checks captions on a 5s timer) cries wolf in every quiet meeting.
// The alarm-worthy states are the capture channel never coming up, dying
// unrecoverably, or the platform telling us captions are unavailable.

export type HealthCode =
  | "opening" // waiting for the capture channel to come up
  | "armed" // channel open, waiting for speech — not a fault
  | "capturing" // at least one utterance accepted
  | "no-channel" // the channel never opened inside CHANNEL_WAIT_MS
  | "channel-lost" // it opened, then died, and could not be recreated
  | "captions-off" // the platform says captions are disabled
  | "host-disabled" // the host has not enabled transcription (Zoom)
  | "unsupported-client" // an unrecognised client build

export interface Health {
  code: HealthCode
  /** ISO time this code was entered. */
  since: string
  detail?: string
}

export type HealthInput =
  | { kind: "tick"; now: string }
  | { kind: "channel-open"; now: string }
  | { kind: "utterance"; now: string }
  | { kind: "reported"; code: HealthCode; detail?: string; now: string }

// How long a capture channel may take to come up before it counts as broken. Meet
// opens its captions channel within a second or two of join; 25s absorbs a slow join
// and a reconnect without letting a genuine failure sit silent for a whole meeting.
export const CHANNEL_WAIT_MS = 25_000

/** Whether this state should be surfaced to the user as a problem. */
export function isAlarming(code: HealthCode): boolean {
  return (
    code === "no-channel" ||
    code === "channel-lost" ||
    code === "captions-off" ||
    code === "host-disabled" ||
    code === "unsupported-client"
  )
}

/**
 * What to tell the user. Deliberately plain: it says what is not happening and what
 * they can do, never a code.
 */
export function healthMessage(code: HealthCode): string {
  switch (code) {
    case "no-channel":
      return "Plática Notes could not start capturing captions in this call — nothing is being recorded. Reload the page to retry."
    case "channel-lost":
      return "Plática Notes lost the caption stream and could not restore it. Reload the page to resume recording; everything captured so far is kept."
    case "captions-off":
      return "Captions are turned off in this meeting, so there is nothing to record."
    case "host-disabled":
      return "The meeting host has not enabled live transcription, so there is nothing to record."
    case "unsupported-client":
      return "Plática Notes does not recognise this meeting client, so nothing is being recorded."
    default:
      return ""
  }
}

export function nextHealth(current: Health, input: HealthInput): Health {
  switch (input.kind) {
    case "utterance":
      // Text is arriving: whatever we thought was wrong, it is not wrong now.
      return current.code === "capturing" ? current : { code: "capturing", since: input.now }
    case "channel-open":
      // Armed. Do not demote a session that is already capturing, and do not restamp
      // an already-armed one: Meet re-subscribes on every language change and on
      // every channel recreate, and `since` must stay the time the state was entered.
      return current.code === "capturing" || current.code === "armed"
        ? current
        : { code: "armed", since: input.now }
    case "reported":
      return current.code === input.code ? current : { code: input.code, since: input.now, detail: input.detail }
    case "tick": {
      // Only the initial wait times out. Silence in an armed channel never does.
      if (current.code !== "opening") return current
      const waited = Date.parse(input.now) - Date.parse(current.since)
      return waited >= CHANNEL_WAIT_MS ? { code: "no-channel", since: input.now } : current
    }
  }
}
