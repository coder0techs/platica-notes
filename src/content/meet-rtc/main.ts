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
import { RTC_CONFIG_EVENT, RTC_EVENT } from "./bridge"
import type { RtcConfig, RtcEvent } from "./bridge"

const DEFAULT_LANG = "ru-RU"
// Meet finishes its own media-session handshake within this window; sending the
// subscribe earlier gets ignored (observed in the spike).
const SUBSCRIBE_DELAY_MS = 1500

// ---------- diagnostics ----------

// Ring buffer of recent lifecycle events on documentElement.dataset — readable
// from an isolated-world script or external automation (AppleScript in Arc).
const RING_MAX = 40
const ring: Record<string, unknown>[] = []

function record(event: Record<string, unknown>): void {
  ring.push({ ...event, ts: Date.now() })
  if (ring.length > RING_MAX) ring.shift()
  try {
    document.documentElement.dataset.platicaRtc = JSON.stringify(ring)
  } catch {
    /* dataset may be unavailable very early */
  }
}

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[platica-rtc]", ...args)
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

let captionLanguage = DEFAULT_LANG

document.addEventListener(RTC_CONFIG_EVENT, (e: Event) => {
  try {
    const detail = (e as CustomEvent).detail
    if (typeof detail !== "string") return
    const cfg = JSON.parse(detail) as RtcConfig
    if (!cfg || typeof cfg.captionLanguage !== "string" || !cfg.captionLanguage) return
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

function trySubscribe(s: MediaSession): void {
  if (s.subscribed || s.channel.readyState !== "open") return
  s.subscribed = true
  // Belt-and-braces: Meet usually creates the captions channel itself once the
  // subscription is active, but creating it explicitly never hurts.
  try {
    s.pc.createDataChannel("captions", { ordered: true, maxRetransmits: 10, id: 50001 })
  } catch (err) {
    record({ phase: "create-captions-error", error: String(err) })
  }
  try {
    s.lang = captionLanguage
    s.channel.send(buildSubscribe(s.op + 1, s.lang) as unknown as ArrayBuffer)
    s.channel.send(buildAck(s.seq + 1) as unknown as ArrayBuffer)
    s.channel.send(buildAck(s.seq + 2) as unknown as ArrayBuffer)
    log("subscribe-sent", { op: s.op + 1, lang: s.lang })
    record({ phase: "subscribe-sent", op: s.op + 1, lang: s.lang })
  } catch (err) {
    s.subscribed = false
    log("subscribe-error", String(err))
    record({ phase: "subscribe-error", error: String(err) })
  }
}

function resubscribeAll(): void {
  // Drop dead channels so a long-lived tab does not accumulate state.
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].channel.readyState === "closed") sessions.splice(i, 1)
  }
  for (const s of sessions) {
    if (!s.subscribed || s.lang === captionLanguage || s.channel.readyState !== "open") continue
    try {
      s.lang = captionLanguage
      s.channel.send(buildSubscribe(s.op + 1, s.lang) as unknown as ArrayBuffer)
      log("subscribe-sent", { op: s.op + 1, lang: s.lang, reason: "config-change" })
      record({ phase: "resubscribe-sent", op: s.op + 1, lang: s.lang })
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
  record({ phase: "transcript", text: m.text.slice(0, 80), deviceId: m.deviceId, messageId: m.messageId })
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
  if (!p || !p.deviceId || !p.text) return
  record({ phase: "chat", deviceId: p.deviceId, text: p.text.slice(0, 80) })
  dispatch({ type: "chat", deviceId: p.deviceId, text: p.text })
}

function handleRoster(bytes: Uint8Array): void {
  const entries = decodeRoster(bytes)
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
  ch.addEventListener("message", (e: MessageEvent) => {
    void (async () => {
      try {
        const bytes = await toBytes(e.data as ArrayBuffer)
        consume(bytes)
      } catch (err) {
        log("decode-error", ch.label, String(err))
        record({ phase: "decode-error", label: ch.label, error: String(err) })
      }
    })()
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
    const s: MediaSession = { channel: ch, pc, op: 0, seq: 0, subscribed: false, lang: captionLanguage }
    sessions.push(s)
    sessionByChannel.set(ch, s)
    if (ch.readyState === "open") setTimeout(() => trySubscribe(s), SUBSCRIBE_DELAY_MS)
    ch.addEventListener("open", () => setTimeout(() => trySubscribe(s), SUBSCRIBE_DELAY_MS))
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origSend as any).apply(this, arguments as any)
  }

  // Catch channels Meet (or we) create locally; `this` is the owning pc.
  const origCreate = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ch: RTCDataChannel = (origCreate as any).apply(this, args)
    handleChannel(ch, this)
    return ch
  }

  const OrigPC = w.RTCPeerConnection
  const Wrapped = function (this: unknown, ...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn: RTCPeerConnection = new (OrigPC as any)(...args)
    log("pc-created")
    record({ phase: "pc-created" })
    conn.addEventListener("datachannel", (ev: RTCDataChannelEvent) => {
      handleChannel(ev.channel, conn)
    })
    return conn
  } as unknown as typeof RTCPeerConnection
  Wrapped.prototype = OrigPC.prototype
  w.RTCPeerConnection = Wrapped

  log("installed")
  record({ phase: "installed" })
  return true
}

if (!install()) {
  record({ phase: "install-skipped", rtc: typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection })
}
