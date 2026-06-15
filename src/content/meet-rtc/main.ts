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
  decodeChatWrapper,
  decodeRoster,
  decodeTranscriptWrapper,
  readNestedOp,
  readNestedSeq,
  toBytes,
} from "./proto"
import { RTC_CONFIG_EVENT, RTC_DEBUG_EVENT, RTC_EVENT } from "./bridge"
import type { RtcConfig, RtcEvent } from "./bridge"
import { DEFAULT_SETTINGS } from "../../shared/types"
// Meet finishes its own media-session handshake within this window; sending the
// subscribe earlier gets ignored (observed in the spike).
const SUBSCRIBE_DELAY_MS = 1500

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
  // Full event (untruncated text) feeds the optional debug stream; the dataset
  // ring keeps a small truncated copy. Read debugEnabled at emit time — config
  // can flip it mid-meeting.
  // Spread event first so framing fields (t, ctx) always win on collision.
  const detail = JSON.stringify({ ...event, t: new Date().toISOString(), ctx: "rtc" })
  if (debugEnabled) {
    dispatchDebug(detail)
  } else if (!configSeen) {
    // Don't yet know if debug is on — retain so a late "debug on" config can
    // still recover the early sequence.
    debugBacklog.push(detail)
    if (debugBacklog.length > DEBUG_BACKLOG_MAX) debugBacklog.shift()
  }
  // else: config seen, debug off — drop.
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

function log(...args: unknown[]): void {
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

function trySubscribe(s: MediaSession): void {
  if (s.subscribed || s.channel.readyState !== "open") return
  s.subscribed = true
  // Belt-and-braces: Meet usually creates the captions channel itself once the
  // subscription is active, but creating it explicitly never hurts. `id`
  // without `negotiated: true` is implementation-dependent — we rely on the
  // try/catch if the browser rejects it.
  try {
    s.pc.createDataChannel("captions", { ordered: true, maxRetransmits: 10, id: 50001 })
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
    log("subscribe-sent", { op, lang: s.lang })
    record({ phase: "subscribe-sent", op, lang: s.lang })
  } catch (err) {
    s.subscribed = false
    log("subscribe-error", String(err))
    record({ phase: "subscribe-error", error: String(err) })
  }
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

// ---------- channel consumers ----------

let firstTranscript = true

function handleCaptions(bytes: Uint8Array): void {
  const m = decodeTranscriptWrapper(bytes)
  if (!m || !m.text || !m.deviceId || m.messageId === undefined || m.messageVersion === undefined) return
  if (firstTranscript) {
    firstTranscript = false
    log("first transcript", { lang: captionLanguage })
  }
  record({ phase: "transcript", text: m.text, deviceId: m.deviceId, messageId: m.messageId })
  dispatch({
    type: "transcript",
    deviceId: m.deviceId,
    messageId: m.messageId,
    messageVersion: m.messageVersion,
    text: m.text,
    langId: m.langId,
  })
}

function handleChat(bytes: Uint8Array): void {
  const p = decodeChatWrapper(bytes)
  // Decode-result diagnostic: see whether the chat decoder yields anything on
  // live wire data. Runs before the empty-guard below. Never throws into capture.
  try {
    record({ phase: "chat-decoded", got: p ? { deviceId: p.deviceId, text: p.text } : null })
  } catch {
    /* diagnostics must never affect capture */
  }
  if (!p || !p.deviceId || !p.text) return
  // Chat text in the diagnostics ring is deliberately the same truncated-PII
  // class as transcript text above (truncation now applied inside record).
  record({ phase: "chat", deviceId: p.deviceId, text: p.text })
  dispatch({ type: "chat", deviceId: p.deviceId, text: p.text })
}

function handleRoster(bytes: Uint8Array): void {
  const entries = decodeRoster(bytes)
  // Decode-result diagnostic: see whether the roster decoder yields anything on
  // live wire data. Never throws into capture.
  try {
    record({ phase: "roster-decoded", count: entries.length, entries: entries.slice(0, 5) })
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
        // gzip-normalized bytes so the hex is the actual protobuf. Runs
        // regardless of whether the decoder below yields anything; never throws
        // into capture.
        if (ch.label !== "captions" && ch.label !== "media-session") {
          try {
            record({ phase: "channel-raw", label: ch.label, bytes: bytes.length, hex: toHex(bytes) })
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
  record({ phase: "channel", label: ch.label, state: ch.readyState })
  log("channel", ch.label)
  if (ch.label === "media-session") {
    pruneDeadSessions()
    const s: MediaSession = { channel: ch, pc, op: 0, seq: 0, subscribed: false, lang: captionLanguage }
    sessions.push(s)
    sessionByChannel.set(ch, s)
    if (ch.readyState === "open") setTimeout(() => trySubscribe(s), SUBSCRIBE_DELAY_MS)
    ch.addEventListener("open", () => setTimeout(() => trySubscribe(s), SUBSCRIBE_DELAY_MS))
    ch.addEventListener("close", () => {
      const i = sessions.indexOf(s)
      if (i >= 0) sessions.splice(i, 1)
    })
  } else if (ch.label === "captions") {
    attachConsumer(ch, handleCaptions)
  } else if (ch.label === "meet_messages") {
    attachConsumer(ch, handleChat)
  } else if (ch.label === "collections") {
    attachConsumer(ch, handleRoster)
  }
}

// ---------- RTCPeerConnection hooks ----------

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
      }
    } catch {
      /* best-effort counters */
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
  record({ phase: "installed" })
  return true
}

if (!install()) {
  record({ phase: "install-skipped", rtc: typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection })
}
