// The delivery-funnel counters and the one decision they involve.
//
// Split out of main.ts so it can be tested: main.ts wraps RTCPeerConnection at
// import time and cannot be loaded from a test. That mattered here — this
// instrument shipped with a bug that silenced it in exactly the situation it
// existed to measure, and nothing caught it until a real meeting was wasted.

export interface FunnelCounts {
  /** Frames seen on the captions channel, before decompression can fail. */
  wire: number
  /** Frames the decoder could read. */
  decoded: number
  /** Frames handed to the isolated world. */
  dispatched: number
  /** Frames the decoder returned nothing usable for. */
  dropped: number
}

export const emptyFunnel = (): FunnelCounts => ({ wire: 0, decoded: 0, dispatched: 0, dropped: 0 })

export const funnelSnapshot = (counts: FunnelCounts): string => JSON.stringify(counts)

/**
 * Whether to write this snapshot to the debug log.
 *
 * The dedupe exists so an idle meeting does not repeat the same line every
 * thirty seconds. It must never apply to the snapshot taken when config
 * arrives: these counters live for the whole page, while the debug log is
 * written per meeting, so a call before the log window opened would set the
 * baseline and silence every call inside the window — leaving the meeting with
 * no reading at all. That is precisely how the first attempt to measure a
 * broken meeting produced nothing.
 */
export function shouldRecordFunnel(snapshot: string, last: string, always: boolean): boolean {
  return always || snapshot !== last
}
