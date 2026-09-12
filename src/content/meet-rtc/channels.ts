// Which Meet data channel carries the transcript, and how to tell when a
// channel we do not recognise has started carrying it.
//
// Pure predicates, no DOM and no chrome.*, so the routing decision in main.ts
// stays a one-line call and this stays covered by tests.
//
// Why this file exists: for the extension's whole life the transcript arrived on
// a channel labelled exactly `captions`. In early September 2026 Meet began
// serving some accounts a `captions_v2` channel instead, per account rather than
// per build, and the old channel then carried nothing at all. An exact-string
// match meant those users recorded empty files and nothing said so. Two layers
// answer that: the name pattern below catches the cheap, predictable case (the
// next versioned rename), and carriesCaptions catches everything else by looking
// at what a channel actually sends rather than at what it is called.

import type { Transcript } from "./proto"

// `captions`, `captions_v2`, `captions_v3`, … and nothing else. Deliberately
// tight: a loose match on the substring would route `captions_metadata` or a
// neighbouring extension's channel into the transcript. Anything this misses is
// the sniffer's job, not this pattern's.
const CAPTIONS_LABEL = /^captions(_v\d+)?$/

export function isCaptionsLabel(label: string): boolean {
  return CAPTIONS_LABEL.test(label)
}

// Everything the feed needs from one caption. Version and id are compared, not
// merely tested for truthiness: revision 0 of message 0 is a real first turn.
export function isUsableCaption(m: Transcript): boolean {
  return (
    typeof m.text === "string" && m.text !== "" &&
    typeof m.deviceId === "string" && m.deviceId !== "" &&
    m.messageId !== undefined &&
    m.messageVersion !== undefined
  )
}

/**
 * Whether a frame that decoded on an UNRECOGNISED channel is really a caption
 * frame, and that channel therefore worth adopting.
 *
 * Stricter than isUsableCaption on purpose. The cost of a false negative is one
 * more release; the cost of a false positive is invented transcript lines
 * assembled out of some other channel's traffic. Requiring the speaker id to be
 * a Meet device path is what makes an accidental parse implausible rather than
 * merely unlikely.
 */
export function carriesCaptions(decoded: Transcript[]): boolean {
  return decoded.some((m) => isUsableCaption(m) && m.deviceId!.includes("/devices/"))
}
