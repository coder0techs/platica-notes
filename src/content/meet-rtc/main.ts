// Google Meet capture via WebRTC data channels (captions / chat / roster).
// Runs in the page MAIN world at document_start so it can wrap RTCPeerConnection
// before Meet captures the original. Decoded events are dispatched to the
// isolated-world adapter as CustomEvents on `document` (see bridge.ts).
//
// Clean reimplementation against Google Meet's wire format. Not derived from any
// third-party source code; only the public protocol shape is used.

import {
  buildAck,
  buildSubscribe,
  decodeCollectionsChat,
  decodeOutgoingChat,
  decodeRoster,
  decodeTranscriptWrapper,
  readNestedOp,
  readNestedSeq,
  toBytes,
} from "./proto"
import { RTC_CONFIG_EVENT, RTC_DEBUG_EVENT, RTC_EVENT } from "./bridge"
import type { RtcConfig, RtcEvent } from "./bridge"
import { makeChannelIdAllocator, shouldRecreateCaptions } from "./lifecycle"
import { extractMeetBuild } from "./build-probe"
import { base64ToBytes, extractRosterPairs, extractSelfDevice, extractSelfName } from "./identity"
import { DEFAULT_SETTINGS } from "../../shared/types"
// Meet finishes its own media-session handshake within this window; sending the
// subscribe earlier gets ignored (observed in the spike).
const SUBSCRIBE_DELAY_MS = 1500
// Captions watchdog poll interval. We keep a live captions channel by checking
// its readyState on this cadence and opening a fresh one (new id) if it drops
// while the peer connection is still up.
const CAPTIONS_WATCH_MS = 1000

// Every captions data channel we open gets a unique, monotonically increasing
// id. Meet leaves the captions channel open when native captions are toggled
// off, so reusing a fixed id would throw "id in use" on recreate and silently
// leave us on a dead channel. A fresh id per channel keeps recreation reliable.
const nextCaptionChannelId = makeChannelIdAllocator()

// ---------- diagnostics ----------

// Ring buffer of recent lifecycle events on documentElement.dataset — readable
// from an isolated-world script or external automation (AppleScript in Arc).
const RING_MAX = 40
const RING_FLUSH_MS = 500
const ring: Record<string, unknown>[] = []
let ringFlushTimer: ReturnType<typeof setTimeout> | undefined

// The MAIN-world script runs at document_start but only learns whether debug is
// enabled when RTC_CONFIG_EVENT arrives — which is AFTER Meet has opened the
// early channels (media-session, collections) and we subscribed. Until config
// is seen we retain every full debug event here, then flush on config arrival
// if debug turned out to be on (otherwise drop). Entries are pre-stringified
// full event strings, ready to dispatch as-is.
let configSeen = false
const debugBacklog: string[] = []
const DEBUG_BACKLOG_MAX = 3000

function flushRing(): void {
  ringFlushTimer = undefined
  try {
    document.documentElement.dataset.platicaRtc = JSON.stringify(ring)
  } catch {
    /* dataset may be unavailable very early */
  }
}

// Dispatch one already-JSON-stringified debug event. Used by record() (live) and
// by the backlog flush (so the string is never re-stringified).
function dispatchDebug(detail: string): void {
  try {
    document.dispatchEvent(new CustomEvent(RTC_DEBUG_EVENT, { detail }))
  } catch {
    /* a debug-dispatch failure must never affect capture */
  }
}

function record(event: Record<string, unknown>): void {
  // Read debugEnabled at emit time — config can flip it mid-meeting. Common
  // case (debug off, config already seen) drops everything before any work,
  // including the JSON.stringify below: nothing reaches the debug stream or the
  // page DOM unless the user opted into the diagnostic log.
  if (!debugEnabled && configSeen) return
  // Full event (untruncated text) feeds the optional debug stream; the dataset
  // ring keeps a small truncated copy. Spread event first so framing fields
  // (t, ctx) always win on collision.
  const detail = JSON.stringify({ ...event, t: new Date().toISOString(), ctx: "rtc" })
  if (debugEnabled) {
    dispatchDebug(detail)
  } else {
    // Config not yet seen — retain so a late "debug on" config can still
    // recover the early sequence. Do NOT touch the dataset ring before we know
    // debug is on (the ring writes caption/chat text to a page-readable DOM
    // attribute; gating it on debugEnabled keeps a default install from leaking
    // any transcript fragment back into the Meet page).
    debugBacklog.push(detail)
    if (debugBacklog.length > DEBUG_BACKLOG_MAX) debugBacklog.shift()
    return
  }
  const ringEvent: Record<string, unknown> = { ...event, ts: Date.now() }
  // Truncate text in the ring copy only — keeps the dataset small.
  if (typeof ringEvent.text === "string") ringEvent.text = ringEvent.text.slice(0, 80)
  ring.push(ringEvent)
  if (ring.length > RING_MAX) ring.shift()
  // Writing dataset on every caption message would fire Meet's attribute
  // MutationObservers several times per second. Flush at most once per
  // RING_FLUSH_MS via a trailing timer, so the last event is never lost.
  if (ringFlushTimer === undefined) ringFlushTimer = setTimeout(flushRing, RING_FLUSH_MS)
}

// Page-console diagnostics, gated on the debug flag so a default install stays
// quiet in the Meet page console. Genuine failures use console.error directly.
function log(...args: unknown[]): void {
  if (!debugEnabled) return
  console.log("[platica-rtc]", ...args)
}

// Hex of the first `max` bytes — feeds the wire-bytes diagnostics for channels
// whose decoder (collections/roster, meet_messages/chat) is not yet proven on
// live data.
function toHex(u: Uint8Array, max = 160): string {
  return [...u.slice(0, max)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// ---------- cross-world event dispatch ----------

function dispatch(event: RtcEvent): void {
  try {
    document.dispatchEvent(new CustomEvent(RTC_EVENT, { detail: JSON.stringify(event) }))
  } catch (err) {
    record({ phase: "dispatch-error", error: String(err) })
  }
}

// Report the current media-path liveness (open media-session count + the owning
// connection's state) to the isolated-world adapter, which uses a sustained zero
// as the authoritative end signal. Always-on (not debug-gated) like the roster
// and self dispatches; carries a count and a state string, never any content.
function dispatchMedia(pc: RTCPeerConnection): void {
  dispatch({ type: "media", openSessions: sessions.length, pcState: pc.connectionState })
}

// ---------- self-name resolution from the GetUser RPC ----------

// Last self name dispatched, so we emit at most once per distinct name.
let lastSelfName: string | null = null
// Last local-device id dispatched (from UpdateMeetingDevice), same dedup intent.
let lastSelfDeviceId: string | null = null
// deviceId name pairs already dispatched from the SyncMeetingSpaceCollections
// roster RPC, so a repeated full-sync does not re-dispatch the same entries.
const dispatchedRoster = new Set<string>()

// ---------- language config from the isolated-world adapter ----------

// Canonical default lives in DEFAULT_SETTINGS.captionLanguage (shared/types.ts).
let captionLanguage = DEFAULT_SETTINGS.captionLanguage
// May flip mid-meeting; record() honours the current value at emit time.
let debugEnabled = false

document.addEventListener(RTC_CONFIG_EVENT, (e: Event) => {
  try {
    const detail = (e as CustomEvent).detail
    if (typeof detail !== "string") return
    const cfg = JSON.parse(detail) as RtcConfig
    if (!cfg || typeof cfg.captionLanguage !== "string" || !cfg.captionLanguage) return
    configSeen = true
    if (cfg.debug) {
      // Debug on: flush the early backlog (each entry already a JSON string),
      // then keep streaming live via record().
      debugEnabled = true
      for (const detailStr of debugBacklog) dispatchDebug(detailStr)
      debugBacklog.length = 0
    } else {
      // Debug off: drop the retained backlog to free memory.
      debugEnabled = false
      debugBacklog.length = 0
    }
    const changed = cfg.captionLanguage !== captionLanguage
    captionLanguage = cfg.captionLanguage
    record({ phase: "config", lang: captionLanguage, changed })
    if (changed) resubscribeAll()
  } catch (err) {
    record({ phase: "config-error", error: String(err) })
  }
})

// ---------- per media-session channel state ----------

// Each media-session channel (one per peer connection, fresh on reconnect or a
// second meeting in the same tab) carries its own op/seq counters and subscribe
// state. The owning pc is remembered so the captions-channel creation attempt
// targets the right connection.
interface MediaSession {
  channel: RTCDataChannel
  pc: RTCPeerConnection
  op: number
  seq: number
  subscribed: boolean
  lang: string
}

const sessions: MediaSession[] = []
const sessionByChannel = new WeakMap<RTCDataChannel, MediaSession>()

// Drop dead channels so a long-lived tab does not retain pcs/channels of
// finished meetings. Called on new session registration, channel close, and
// language change.
function pruneDeadSessions(): void {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].channel.readyState === "closed") sessions.splice(i, 1)
  }
}

// Create the captions data channel and send the subscribe op + acks. No guard —
// callers decide when to (re)subscribe. Used for the first subscribe and to
// recreate our own captions channel after it drops (e.g. a native-caption
// toggle). Each call opens a channel with a fresh unique id (see allocator) so a
// recreate never collides with a still-open previous channel.
function sendSubscribe(s: MediaSession): void {
  if (s.channel.readyState !== "open") return
  // Open our own captions channel so capture keeps running regardless of the
  // native-caption UI. `id` without `negotiated: true` is implementation-
  // dependent — we rely on the try/catch if the browser rejects it. The channel
  // funnels back through handleChannel (consumer + watchdog) like any other.
  try {
    const id = nextCaptionChannelId()
    s.pc.createDataChannel("captions", { ordered: true, maxRetransmits: 10, id })
    record({ phase: "captions-create", id, pc: s.pc.connectionState })
  } catch (err) {
    record({ phase: "create-captions-error", error: String(err) })
  }
  try {
    s.lang = captionLanguage
    const op = s.op + 1
    // Cast: TS 6 types Uint8Array as Uint8Array<ArrayBufferLike>, which does
    // not satisfy send's ArrayBufferView<ArrayBuffer> overload.
    s.channel.send(buildSubscribe(op, s.lang) as unknown as ArrayBuffer)
    // Bump locally so a later re-subscribe never reuses this op; Meet's own
    // traffic overwrites the counter via the send hook anyway.
    s.op = op
    s.channel.send(buildAck(s.seq + 1) as unknown as ArrayBuffer)
    s.channel.send(buildAck(s.seq + 2) as unknown as ArrayBuffer)
    s.subscribed = true
    log("subscribe-sent", { op, lang: s.lang })
    record({ phase: "subscribe-sent", op, lang: s.lang })
  } catch (err) {
    s.subscribed = false
    log("subscribe-error", String(err))
    record({ phase: "subscribe-error", error: String(err) })
  }
}

function trySubscribe(s: MediaSession): void {
  if (s.subscribed || s.channel.readyState !== "open") return
  sendSubscribe(s)
}

// Keep a live captions channel on a connection. The transcript only flows while
// a captions channel is open, but a native-caption toggle-off does not close the
// channel or fire any event — and when it DOES drop (reconnect, Meet teardown of
// its own channel) there is likewise no reliable close event we can hang capture
// recovery on. So we poll the channel's readyState and, the moment it is gone
// while the pc is still up, open a fresh one (new id) on that pc and re-subscribe.
// One watchdog is attached per captions channel we see (in handleChannel); when a
// channel drops, the replacement we open gets its own watchdog, continuing the
// chain. The watchdog stops itself once the channel is gone (it either recreated
// or the pc is closed/failed), so it never spins on a dead connection.
function watchCaptionsChannel(pc: RTCPeerConnection, ch: RTCDataChannel): void {
  const tick = (): void => {
    const cs = ch.readyState
    if (cs === "closing" || cs === "closed") {
      if (!shouldRecreateCaptions(cs, pc.connectionState)) return
      const s = sessions.find((x) => x.pc === pc && x.channel.readyState === "open")
      record({ phase: "captions-recreate", id: ch.id, pc: pc.connectionState, haveSession: !!s })
      if (s) sendSubscribe(s)
      return
    }
    setTimeout(tick, CAPTIONS_WATCH_MS)
  }
  setTimeout(tick, CAPTIONS_WATCH_MS)
}

function resubscribeAll(): void {
  pruneDeadSessions()
  for (const s of sessions) {
    if (s.channel.readyState !== "open") continue
    // Session that never successfully subscribed (e.g. initial send threw and
    // no further "open" event will fire): use the same trySubscribe path so
    // op/seq handling stays identical.
    if (!s.subscribed) {
      trySubscribe(s)
      continue
    }
    // Already subscribed but the language changed — send a fresh subscribe.
    if (s.lang === captionLanguage) continue
    try {
      s.lang = captionLanguage
      const op = s.op + 1
      s.channel.send(buildSubscribe(op, s.lang) as unknown as ArrayBuffer)
      s.op = op
      log("subscribe-sent", { op, lang: s.lang, reason: "config-change" })
      record({ phase: "resubscribe-sent", op, lang: s.lang })
    } catch (err) {
      record({ phase: "resubscribe-error", error: String(err) })
    }
  }
}

// Re-assert the caption subscription on every already-subscribed media-session.
// Called when a captions channel (re)opens after we were already subscribed —
// Meet recreates the captions channel when the user toggles native captions, and
// the original subscription does not carry over, so without this the transcript
// stops until native captions are switched back on. Sessions that have not
// subscribed yet are left to trySubscribe (their own open handler).
function resubscribeForCaptions(reason = "captions-reopened"): void {
  pruneDeadSessions()
  for (const s of sessions) {
    if (!s.subscribed || s.channel.readyState !== "open") continue
    try {
      const op = s.op + 1
      s.channel.send(buildSubscribe(op, s.lang) as unknown as ArrayBuffer)
      s.op = op
      record({ phase: "resubscribe-sent", op, lang: s.lang, reason })
    } catch (err) {
      record({ phase: "resubscribe-error", error: String(err) })
    }
  }
}

// ---------- channel consumers ----------

let firstTranscript = true

function handleCaptions(bytes: Uint8Array): void {
  const m = decodeTranscriptWrapper(bytes)
  if (!m || !m.text || !m.deviceId || m.messageId === undefined || m.messageVersion === undefined) return
  if (firstTranscript) {
    firstTranscript = false
    log("first transcript", { lang: captionLanguage })
  }
  record({ phase: "transcript", text: m.text, deviceId: m.deviceId, messageId: m.messageId, langId: m.langId })
  dispatch({
    type: "transcript",
    deviceId: m.deviceId,
    messageId: m.messageId,
    messageVersion: m.messageVersion,
    text: m.text,
  })
}

// Chat now rides the collections channel (Google Meet moved it off meet_messages
// onto Google-Chat-backed meeting-space collections). One packet can carry several
// messages (the collection batches/replays), so decode returns an array; the feed
// dedupes replays by messageId.
function handleChat(bytes: Uint8Array): void {
  const messages = decodeCollectionsChat(bytes)
  for (const p of messages) {
    // Decode-result diagnostic: see what the chat decoder yields on live wire data.
    try {
      record({ phase: "chat-decoded", got: { deviceId: p.deviceId, text: p.text, sender: p.sender, messageId: p.messageId } })
    } catch {
      /* diagnostics must never affect capture */
    }
    if (!p.deviceId || !p.text) continue
    // Chat text in the diagnostics ring is deliberately the same truncated-PII
    // class as transcript text above (truncation now applied inside record).
    record({ phase: "chat", deviceId: p.deviceId, text: p.text })
    // Pass sender/messageId through only when present; the feed prefers the
    // embedded sender over the roster and dedupes on messageId.
    dispatch({
      type: "chat",
      deviceId: p.deviceId,
      text: p.text,
      ...(p.sender ? { sender: p.sender } : {}),
      ...(p.messageId ? { messageId: p.messageId } : {}),
    })
  }
}

// The collections channel multiplexes roster (devices) and chat (messages), so a
// single consumer feeds both decoders; each ignores the other's entries.
function handleCollections(bytes: Uint8Array): void {
  handleRoster(bytes)
  handleChat(bytes)
}

function handleRoster(bytes: Uint8Array): void {
  const entries = decodeRoster(bytes)
  // Decode-result diagnostic: see whether the roster decoder yields anything on
  // live wire data. Never throws into capture.
  try {
    record({ phase: "roster-decoded", count: entries.length, entries })
  } catch {
    /* diagnostics must never affect capture */
  }
  let dispatched = 0
  for (const entry of entries) {
    // The adapter dedupes by deviceId; here we only skip empties.
    if (!entry.deviceId || !entry.deviceName) continue
    dispatch({ type: "device", deviceId: entry.deviceId, deviceName: entry.deviceName })
    dispatched++
  }
  if (dispatched > 0) record({ phase: "roster", count: dispatched })
}

// Diagnostic-only consumer for data channels we do NOT otherwise read (copresent,
// coannotations, s11y-sync, and any future label). Meet stopped opening the
// meet_messages channel our chat reader is bound to, and an incoming chat message
// from another participant was never observed on it — so we do not yet know which
// channel now carries received chat. This logs the raw (gzip-normalized) bytes of
// every message on such a channel, but ONLY when the debug log is enabled: the
// debugEnabled guard runs BEFORE any read/decompress, so a default install reads
// nothing off these channels and does no work. It never decodes, dispatches, or
// otherwise changes capture — it exists purely to locate the incoming-chat
// transport from a real two-party meeting, then it can be removed.
function attachRawDiagnostic(ch: RTCDataChannel): void {
  let queue: Promise<void> = Promise.resolve()
  ch.addEventListener("message", (e: MessageEvent) => {
    // Gate first: no reading, no work, nothing recorded unless debug is on.
    if (!debugEnabled) return
    if (!(e.data instanceof ArrayBuffer) && !(e.data instanceof Uint8Array)) return
    const data = e.data as ArrayBuffer
    queue = queue.then(async () => {
      try {
        const bytes = await toBytes(data)
        record({ phase: "channel-raw", label: ch.label, bytes: bytes.length, hex: toHex(bytes, bytes.length) })
      } catch {
        /* diagnostics must never affect capture */
      }
    })
  })
}

function attachConsumer(ch: RTCDataChannel, consume: (bytes: Uint8Array) => void): void {
  // toBytes is async (gzip goes through DecompressionStream), so two messages
  // can finish decoding out of order, emitting events with regressing
  // versions. Chain handler runs on a per-channel promise so events are
  // processed strictly in arrival order.
  let queue: Promise<void> = Promise.resolve()
  ch.addEventListener("message", (e: MessageEvent) => {
    if (!(e.data instanceof ArrayBuffer) && !(e.data instanceof Uint8Array)) {
      record({ phase: "unexpected-payload", label: ch.label, type: typeof e.data })
      return
    }
    const data = e.data as ArrayBuffer
    queue = queue.then(async () => {
      try {
        const bytes = await toBytes(data)
        // Wire-bytes diagnostics for channels whose decode is not yet proven on
        // live data (collections/roster, meet_messages/chat, any other). Use the
        // gzip-normalized bytes so the hex is the actual protobuf. Debug-gated
        // BEFORE building the hex: serializing every non-caption payload to hex
        // on the page's hot path is pure waste when debug is off (the default).
        if (debugEnabled && ch.label !== "captions" && ch.label !== "media-session") {
          try {
            record({ phase: "channel-raw", label: ch.label, bytes: bytes.length, hex: toHex(bytes, bytes.length) })
          } catch {
            /* diagnostics must never affect capture */
          }
        }
        consume(bytes)
      } catch (err) {
        log("decode-error", ch.label, String(err))
        record({ phase: "decode-error", label: ch.label, error: String(err) })
      }
    })
  })
}

// ---------- channel routing ----------

// A channel can be created locally (createDataChannel) or arrive remotely
// (datachannel event); both paths funnel here with the owning pc.
const seenChannels = new WeakSet<RTCDataChannel>()

function handleChannel(ch: RTCDataChannel, pc: RTCPeerConnection): void {
  if (seenChannels.has(ch)) return
  seenChannels.add(ch)
  record({ phase: "channel", label: ch.label, state: ch.readyState, pc: pc.connectionState, id: ch.id })
  log("channel", ch.label)
  if (ch.label === "media-session") {
    pruneDeadSessions()
    const s: MediaSession = { channel: ch, pc, op: 0, seq: 0, subscribed: false, lang: captionLanguage }
    sessions.push(s)
    sessionByChannel.set(ch, s)
    record({ phase: "media-session-open", state: ch.readyState, sessions: sessions.length })
    // A new peer connection appeared — tell the adapter the media path is live so
    // it cancels any pending end (reconnect / a second meeting in the same tab).
    dispatchMedia(pc)
    if (ch.readyState === "open") setTimeout(() => trySubscribe(s), SUBSCRIBE_DELAY_MS)
    ch.addEventListener("open", () => setTimeout(() => trySubscribe(s), SUBSCRIBE_DELAY_MS))
    ch.addEventListener("close", () => {
      const i = sessions.indexOf(s)
      if (i >= 0) sessions.splice(i, 1)
      record({ phase: "media-session-closed", pc: pc.connectionState, sessions: sessions.length })
      // Count dropped — when it reaches zero the adapter arms the end grace.
      dispatchMedia(pc)
    })
  } else if (ch.label === "captions") {
    attachConsumer(ch, handleCaptions)
    // A captions channel opening while a media-session is already subscribed means
    // Meet recreated it (e.g. the user toggled native captions) or we just opened
    // our own. Re-assert the subscription so the stream resumes in our language.
    // Delayed so the new channel is open before Meet processes the re-subscribe.
    setTimeout(resubscribeForCaptions, SUBSCRIBE_DELAY_MS)
    // Watch this channel: if it drops while the pc is still up, the watchdog opens
    // a fresh captions channel (new id) and re-subscribes — recovery does not
    // depend on a close event firing (a native-caption toggle-off fires none).
    watchCaptionsChannel(pc, ch)
    // Diagnostics only — the watchdog (not this listener) drives recovery.
    ch.addEventListener("close", () => {
      const open = sessions.filter((s) => s.channel.readyState === "open").length
      record({ phase: "captions-closed", id: ch.id, pc: pc.connectionState, sessions: sessions.length, openSessions: open })
    })
  } else if (ch.label === "collections") {
    attachConsumer(ch, handleCollections)
  } else {
    // Any other channel (copresent, coannotations, s11y-sync, …). We do not read
    // these for capture; attach a debug-gated raw logger so a two-party meeting
    // reveals where incoming chat now flows (see attachRawDiagnostic).
    attachRawDiagnostic(ch)
  }
}

// ---------- RTCPeerConnection hooks ----------

// The fetch/XHR wrappers below read response bodies for two reasons: the three
// named RPCs that resolve participant names (a real feature, always on) and the
// generic RPC hex dump (diagnostics, debug-only). Everything else must NOT have
// its body cloned/read — that would make a "local transcript" tool a broad
// interceptor of Meet's traffic for no purpose. This gate keeps the body read
// (and any decode/parse) confined to exactly what is used.
const NAME_RPC_SUFFIXES = [
  "MeetingUserService/GetUser",
  "MeetingDeviceService/UpdateMeetingDevice",
  "MeetingSpaceService/SyncMeetingSpaceCollections",
]
function wantsBody(url: string): boolean {
  if (!url.includes("meet.google.com")) return false
  if (NAME_RPC_SUFFIXES.some((s) => url.endsWith(s))) return true
  // Any other Meet response is only of interest to the diagnostic log.
  return debugEnabled
}

function install(): boolean {
  const w = window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection; __platicaRtc?: boolean }
  if (!w.RTCPeerConnection || w.__platicaRtc) return false
  w.__platicaRtc = true

  // Track Meet's own op (big packet) / seq (small packet) counters per channel
  // from outgoing media-session sends.
  const origSend = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
    try {
      if (this.label === "media-session" && data instanceof ArrayBuffer) {
        const s = sessionByChannel.get(this)
        if (s) {
          const u = new Uint8Array(data)
          const op = readNestedOp(u)
          if (op !== undefined) s.op = op
          const seq = readNestedSeq(u)
          if (seq !== undefined) s.seq = seq
        }
      } else {
        // Own outgoing chat (real feature, always on): the local user's message is
        // never echoed back to this client (collections only carries OTHERS' chat),
        // so we read it from the outgoing meet_messages send and attribute it to
        // self. Read-only: we decode a view and call through to the real send.
        if (this.label === "meet_messages" && (data instanceof ArrayBuffer || data instanceof Uint8Array)) {
          try {
            const own = decodeOutgoingChat(data instanceof Uint8Array ? data : new Uint8Array(data))
            if (own?.text) {
              record({ phase: "chat", deviceId: lastSelfDeviceId ?? "self", text: own.text })
              dispatch({
                type: "chat",
                deviceId: lastSelfDeviceId ?? "self",
                text: own.text,
                ...(lastSelfName ? { sender: lastSelfName } : {}),
                // Dedupe key: the client timestamp is stable across any retransmit
                // of the same send; fall back to the text when it is absent.
                messageId: `self-out/${own.sentAt ?? own.text}`,
              })
            }
          } catch {
            /* own-chat capture must never affect the send */
          }
        }
        // Diagnostic (debug-gated): log OUTGOING sends on non-media channels, so a
        // future channel/format change is visible in the debug log.
        if (debugEnabled && this.label !== "media-session") {
          const label = this.label
          if (typeof data === "string") {
            record({ phase: "send-str", label, len: data.length, text: data.slice(0, 500) })
          } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0))
            void toBytes(copy)
              .then((bytes) => record({ phase: "send-raw", label, bytes: bytes.length, hex: toHex(bytes, bytes.length) }))
              .catch(() => {
                /* diagnostics must never affect the send */
              })
          }
        }
      }
    } catch {
      /* best-effort counters + diagnostics must never affect the send */
    }
    return (origSend as any).apply(this, arguments as any)
  }

  // Catch channels Meet (or we) create locally; `this` is the owning pc.
  // Our code is try/caught so an exception here can never break Meet's call.
  const origCreate = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...args: unknown[]) {
    const ch: RTCDataChannel = (origCreate as any).apply(this, args)
    try {
      handleChannel(ch, this)
    } catch (err) {
      record({ phase: "hook-error", where: "createDataChannel", error: String(err) })
    }
    return ch
  }

  // RPC response capture (debug-gated via record()). Meet does NOT include the
  // local user's own device in the `collections` roster channel, so transcript
  // lines for the self device fall back to "Speaker N". To locate where the
  // self deviceId + display name live we capture Meet's internal RPC responses
  // (fetch + XHR) and dump their body bytes as hex into the debug log.
  //
  // Privacy: this path is debug-only (opt-in via Settings.debugLog, default off)
  // and writes to the local-only "Platica Logs" folder. We log the request URL
  // and the response body bytes only — never request headers, cookies, or auth.
  //
  // Both wrappers always call through to the originals and return their result
  // untouched; only the logging is conditional (record() drops when debug off).
  // Every wrapper is fully try/caught so it can never throw into Meet's request.

  // Parse the three name RPCs (always), then — only when the debug log is on —
  // record other matching responses through record() with the FULL body hex
  // (RPC bodies are bigger than channel messages and the self-device name may be
  // nested deep, so the diagnostic keeps the whole body rather than a window).
  function logRpc(method: string, url: string, status: number, bytes: Uint8Array): void {
    try {
      if (!url.includes("meet.google.com")) return
      // Self-name resolution: parse the GetUser RPC and dispatch the local
      // user's display name. This is a real feature, not diagnostics, so it
      // runs regardless of debugEnabled (the fetch/XHR hook always fires).
      // Only the GetUser endpoint is parsed; everything else falls through.
      // Fully try/caught so it can never throw into Meet's request handling.
      if (url.endsWith("MeetingUserService/GetUser")) {
        try {
          // Body is base64 ASCII text wrapping a protobuf.
          const text = new TextDecoder("utf-8").decode(bytes)
          const decoded = base64ToBytes(text)
          const name = decoded ? extractSelfName(decoded) : null
          if (name && name !== lastSelfName) {
            lastSelfName = name
            dispatch({ type: "self", name })
            record({ phase: "self", name })
          }
        } catch (err) {
          record({ phase: "self-error", error: String(err) })
        }
      }
      // Local-device resolution: the UpdateMeetingDevice RPC carries the local
      // user's own deviceId → name (the one absent from the collections roster).
      // Seed it as a normal roster device so self resolves to a real name. Runs
      // regardless of debugEnabled; fully try/caught so it never throws into Meet.
      if (url.endsWith("MeetingDeviceService/UpdateMeetingDevice")) {
        try {
          const text = new TextDecoder("utf-8").decode(bytes)
          const decoded = base64ToBytes(text)
          const self = decoded ? extractSelfDevice(decoded) : null
          if (self && self.deviceId !== lastSelfDeviceId) {
            lastSelfDeviceId = self.deviceId
            dispatch({ type: "device", deviceId: self.deviceId, deviceName: self.deviceName })
            record({ phase: "self-device", deviceId: self.deviceId, name: self.deviceName })
          }
        } catch (err) {
          record({ phase: "self-device-error", error: String(err) })
        }
      }
      // Roster resolution: the SyncMeetingSpaceCollections RPC response carries the
      // full participant roster (deviceId -> name) — a reliable source even when
      // the collections data channel never broadcasts it. Seed every entry as a
      // roster device. Runs regardless of debugEnabled; fully try/caught.
      if (url.endsWith("MeetingSpaceService/SyncMeetingSpaceCollections")) {
        try {
          const text = new TextDecoder("utf-8").decode(bytes)
          const decoded = base64ToBytes(text)
          for (const { deviceId, deviceName } of decoded ? extractRosterPairs(decoded) : []) {
            const key = `${deviceId} ${deviceName}`
            if (dispatchedRoster.has(key)) continue
            dispatchedRoster.add(key)
            dispatch({ type: "device", deviceId, deviceName })
            record({ phase: "roster-rpc", deviceId, name: deviceName })
          }
        } catch (err) {
          record({ phase: "roster-rpc-error", error: String(err) })
        }
      }
      // Generic RPC body capture is a diagnostic — gate it on debug so the full
      // response hex is never built (let alone recorded) for an off-by-default
      // install. The three named RPCs above are real features and run regardless.
      if (!debugEnabled) return
      const lower = url.toLowerCase()
      if (
        lower.includes(".js") ||
        lower.includes(".css") ||
        lower.includes(".png") ||
        lower.includes(".jpg") ||
        lower.includes(".woff") ||
        lower.includes(".svg") ||
        lower.includes(".ico") ||
        lower.includes("/gen_204") ||
        lower.includes("/log?")
      ) {
        return
      }
      record({ phase: "rpc", method, url, status, bytes: bytes.length, hex: toHex(bytes, bytes.length) })
    } catch {
      /* diagnostics must never affect Meet's request */
    }
  }

  // Diagnostic (debug-only): log OUTGOING request bodies. Chat you send is a POST
  // to Google's chat backend (a non-meet host), carried in the REQUEST body — the
  // response readers above never see it. This locates the chat-send endpoint and
  // its payload so own-message capture can be wired. Skips static assets and
  // bodyless requests; records url + method + a text preview + a bounded hex.
  // Read-only: nothing here changes the request.
  function logOutbound(method: string, url: string, bytes: Uint8Array | undefined): void {
    try {
      if (!debugEnabled || !bytes || bytes.length === 0) return
      const lower = url.toLowerCase()
      if (
        lower.includes(".js") || lower.includes(".css") || lower.includes(".png") ||
        lower.includes(".jpg") || lower.includes(".woff") || lower.includes(".svg") ||
        lower.includes(".ico") || lower.includes("/gen_204") || lower.includes("/log?")
      ) {
        return
      }
      void toBytes(bytes)
        .then((norm) => {
          let text: string | undefined
          try {
            text = new TextDecoder("utf-8", { fatal: false }).decode(norm).slice(0, 400)
          } catch {
            /* non-text body */
          }
          record({ phase: "outbound", method, url, bytes: norm.length, text, hex: toHex(norm, Math.min(norm.length, 400)) })
        })
        .catch(() => {
          /* diagnostics must never affect the request */
        })
    } catch {
      /* diagnostics must never affect the request */
    }
  }

  function bodyToBytes(body: unknown): Uint8Array | undefined {
    if (typeof body === "string") return new TextEncoder().encode(body)
    if (body instanceof Uint8Array) return body
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return undefined
  }

  // fetch: call through, read a CLONE of the response body asynchronously, and
  // ALWAYS return the original Response untouched (the clone is what we consume,
  // so Meet's reader sees a pristine body). Never await the logging.
  try {
    const origFetch = window.fetch
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const p = (origFetch as any).apply(this, args)
      try {
        const input = args[0]
        const method =
          (args[1] && (args[1] as RequestInit).method) ||
          (input instanceof Request ? input.method : "GET") ||
          "GET"
        const url = input instanceof Request ? input.url : String(input)
        // Diagnostic: log the OUTGOING request body (where our own chat lives).
        if (debugEnabled) {
          const b = bodyToBytes((args[1] as RequestInit | undefined)?.body)
          if (b) logOutbound(method, url, b)
          else if (input instanceof Request) {
            try {
              input.clone().arrayBuffer().then((ab) => logOutbound(method, url, new Uint8Array(ab))).catch(() => {})
            } catch {
              /* clone may throw on some request types */
            }
          }
        }
        // Skip the clone+read entirely unless this URL's body is actually used.
        if (!wantsBody(url)) return p
        Promise.resolve(p)
          .then((res: Response) => {
            try {
              res
                .clone()
                .arrayBuffer()
                .then((buf) => logRpc(method, url, res.status, new Uint8Array(buf)))
                .catch(() => {
                  /* body read failure must not affect Meet */
                })
            } catch {
              /* clone may throw on some response types */
            }
          })
          .catch(() => {
            /* a rejected fetch is Meet's concern, not ours */
          })
      } catch {
        /* logging setup must never affect Meet's request */
      }
      return p
    } as typeof fetch
  } catch (err) {
    record({ phase: "hook-error", where: "fetch", error: String(err) })
  }

  // XHR: stash method+url on the instance at open(); on load read the response
  // (arraybuffer when available, else text) and log it. Behaviour is unchanged.
  try {
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest & { __platicaMethod?: string; __platicaUrl?: string },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        this.__platicaMethod = method
        this.__platicaUrl = String(url)
      } catch {
        /* stashing must never affect the request */
      }
      try {
        this.addEventListener("load", function (this: XMLHttpRequest & { __platicaMethod?: string; __platicaUrl?: string }) {
          try {
            // Skip the response read entirely unless this URL's body is used.
            if (!wantsBody(this.__platicaUrl ?? "")) return
            let bytes: Uint8Array | undefined
            if (this.responseType === "arraybuffer" && this.response instanceof ArrayBuffer) {
              bytes = new Uint8Array(this.response)
            } else if (this.responseType === "" || this.responseType === "text") {
              // responseText only readable for "" / "text" responseType — any
              // other value (json, blob, document) throws when accessed.
              bytes = new TextEncoder().encode(this.responseText ?? "")
            }
            if (bytes) logRpc(this.__platicaMethod ?? "GET", this.__platicaUrl ?? "", this.status, bytes)
          } catch {
            /* response read failure must not affect Meet */
          }
        })
      } catch {
        /* listener attach must never affect the request */
      }
      return (origOpen as any).apply(this, [method, url, ...rest])
    } as typeof XMLHttpRequest.prototype.open
  } catch (err) {
    record({ phase: "hook-error", where: "xhr-open", error: String(err) })
  }

  // XHR send: diagnostic (debug-only) log of the OUTGOING request body, same
  // purpose as the fetch outbound logger. Calls through untouched.
  try {
    const origXhrSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest & { __platicaMethod?: string; __platicaUrl?: string },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      try {
        if (debugEnabled && body != null) {
          const b = bodyToBytes(body)
          if (b) logOutbound(this.__platicaMethod ?? "GET", this.__platicaUrl ?? "", b)
        }
      } catch {
        /* diagnostics must never affect the request */
      }
      return (origXhrSend as any).apply(this, arguments as any)
    } as typeof XMLHttpRequest.prototype.send
  } catch (err) {
    record({ phase: "hook-error", where: "xhr-send", error: String(err) })
  }

  const OrigPC = w.RTCPeerConnection
  const Wrapped = function (this: unknown, ...args: unknown[]) {
    const conn: RTCPeerConnection = new (OrigPC as any)(...args)
    // Same rule as above: nothing of ours may throw into Meet's constructor call.
    try {
      log("pc-created")
      record({ phase: "pc-created" })
      conn.addEventListener("datachannel", (ev: RTCDataChannelEvent) => {
        try {
          handleChannel(ev.channel, conn)
        } catch (err) {
          record({ phase: "hook-error", where: "datachannel", error: String(err) })
        }
      })
    } catch (err) {
      record({ phase: "hook-error", where: "pc-constructor", error: String(err) })
    }
    return conn
  } as unknown as typeof RTCPeerConnection
  Wrapped.prototype = OrigPC.prototype
  // Preserve statics (e.g. RTCPeerConnection.generateCertificate).
  Object.setPrototypeOf(Wrapped, OrigPC)
  w.RTCPeerConnection = Wrapped

  log("installed")
  // Stamp the build so the very first debug event identifies which build ran.
  // typeof-guarded: these globals are undefined under vitest.
  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
  const commit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"
  record({ phase: "installed", version, commit })
  // Capture Meet's server build tag so a future capture regression can be pinned to
  // a specific Meet release. WIZ_global_data may not exist yet at document_start, so
  // poll a few times, then give up quietly. Fully guarded; the debug log is where it
  // lands (record() drops it when debug is off).
  probeMeetBuild()
  return true
}

function probeMeetBuild(tries = 0): void {
  try {
    const build = extractMeetBuild((window as unknown as { WIZ_global_data?: unknown }).WIZ_global_data)
    if (build) {
      record({ phase: "meet-build", build })
      return
    }
  } catch (err) {
    record({ phase: "meet-build-error", error: String(err) })
    return
  }
  if (tries < 5) setTimeout(() => probeMeetBuild(tries + 1), 1000)
}

if (!install()) {
  record({ phase: "install-skipped", rtc: typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection })
}
