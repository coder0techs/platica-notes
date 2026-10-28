// Pure helpers for the captions-channel lifecycle, split out of main.ts so they
// can be unit-tested without the RTCPeerConnection install side effects (main.ts
// runs install() at import time and touches window/RTCPeerConnection).
//
// Clean reimplementation against Google Meet's behaviour. Not derived from any
// third-party source code; only the observed protocol shape is used.

// Each captions data channel needs a unique SCTP id. Reusing an id while the
// previous channel is still open makes createDataChannel throw "id in use" — and
// Meet does NOT close the captions channel when the user turns native captions
// off, so a fixed id strands us on a dead channel after a toggle. An incrementing
// allocator gives every (re)created channel a fresh, collision-free id.
export function makeChannelIdAllocator(start = 50000): () => number {
  let id = start
  return () => ++id
}

// Recreate the captions channel only when it is actually gone (closing/closed)
// AND the peer connection can still host a replacement. While the channel is
// alive we leave it be; once the pc is closed/failed the meeting is over and
// there is nothing to recreate.
export function shouldRecreateCaptions(
  channelState: RTCDataChannelState,
  pcState: RTCPeerConnectionState,
): boolean {
  if (channelState !== "closing" && channelState !== "closed") return false
  return pcState !== "closed" && pcState !== "failed"
}

// Whether a media-session is the one carrying the caption subscription right
// now. Meet numbers caption messages per device PER SUBSCRIPTION, so a second
// subscription on another peer connection (the local user presenting opens one,
// 2026-10-26) streams every caption twice with ids restarting at 1. Only one
// session may be subscribed at a time: a new one waits while a live primary
// exists and takes over when the primary's channel or pc goes.
export function isLivePrimary(s: {
  subscribed: boolean
  channelState: RTCDataChannelState
  pcState: RTCPeerConnectionState
}): boolean {
  if (!s.subscribed || s.channelState !== "open") return false
  return s.pcState === "new" || s.pcState === "connecting" || s.pcState === "connected"
}
