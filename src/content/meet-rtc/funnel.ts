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

// There is deliberately no "skip if unchanged" here any more.
//
// It seemed obviously right — why write the same line every ten seconds? — and
// it destroyed the evidence three separate times. The whole question these
// snapshots answer is "did anything ever arrive", and the answer that matters is
// a run of identical zeros. Suppressing repeats suppresses exactly the finding,
// and leaves a log in which a broken meeting and a healthy one look the same:
// empty. A few hundred small lines cost nothing next to the hex dumps already in
// these files.
