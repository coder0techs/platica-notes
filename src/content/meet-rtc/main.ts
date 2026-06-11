// SPIKE — Google Meet caption capture via the WebRTC `captions` data channel.
// Runs in the page MAIN world at document_start so it can wrap RTCPeerConnection
// before Meet captures the original. Goal of this spike: prove we can (a) hook the
// peer connection, (b) open the `captions` channel + subscribe over `media-session`
// without enabling Meet's caption UI, (c) decode the transcript protobuf.
//
// Results are written to documentElement.dataset.platicaSpike (readable from an
// isolated-world reader / external automation) and logged to the console.
//
// Clean reimplementation against Google Meet's wire format. Not derived from any
// third-party source code; only the public protocol shape is used.

const SPIKE_LANG = "ru-RU"
const events: unknown[] = []

function emit(event: Record<string, unknown>): void {
  events.push({ ...event, ts: Date.now() })
  try {
    document.documentElement.dataset.platicaSpike = JSON.stringify(events.slice(-60))
  } catch {
    /* dataset may be unavailable very early */
  }
  // eslint-disable-next-line no-console
  console.log("[platica-spike]", event)
}

// ---------- protobuf (minimal varint reader) ----------

interface Cursor { buf: Uint8Array; i: number }

function readVarint(c: Cursor): number {
  let result = 0
  let shift = 0
  for (;;) {
    const byte = c.buf[c.i++]
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return result
}

function readTag(c: Cursor): { field: number; wire: number } {
  const key = readVarint(c)
  return { field: key >>> 3, wire: key & 7 }
}

function skip(c: Cursor, wire: number): void {
  if (wire === 0) readVarint(c)
  else if (wire === 2) c.i += readVarint(c)
  else if (wire === 5) c.i += 4
  else if (wire === 1) c.i += 8
}

const decoder = new TextDecoder()

interface Transcript { deviceId?: string; messageId?: number; messageVersion?: number; text?: string; langId?: number }

function decodeTranscript(buf: Uint8Array, start: number, end: number): Transcript {
  const c: Cursor = { buf, i: start }
  const out: Transcript = {}
  while (c.i < end) {
    const { field, wire } = readTag(c)
    if (field === 1 && wire === 2) { const l = readVarint(c); out.deviceId = decoder.decode(buf.slice(c.i, c.i + l)); c.i += l }
    else if (field === 2 && wire === 0) out.messageId = readVarint(c)
    else if (field === 3 && wire === 0) out.messageVersion = readVarint(c)
    else if (field === 6 && wire === 2) { const l = readVarint(c); out.text = decoder.decode(buf.slice(c.i, c.i + l)); c.i += l }
    else if (field === 8 && wire === 0) out.langId = readVarint(c)
    else skip(c, wire)
  }
  return out
}

// Wrapper: field 1 = message (length-delimited), field 2 = unknown2 (presence = not a transcript).
function decodeTranscriptWrapper(buf: Uint8Array): Transcript | null {
  const c: Cursor = { buf, i: 0 }
  let message: Transcript | null = null
  let hasUnknown2 = false
  while (c.i < buf.length) {
    const { field, wire } = readTag(c)
    if (field === 1 && wire === 2) { const l = readVarint(c); message = decodeTranscript(buf, c.i, c.i + l); c.i += l }
    else if (field === 2 && wire === 2) { hasUnknown2 = true; skip(c, wire) }
    else skip(c, wire)
  }
  return hasUnknown2 ? null : message
}

// ---------- protobuf (minimal writer) ----------

function writeVarint(n: number, out: number[]): void {
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) }
  out.push(n)
}
function tag(field: number, wire: number, out: number[]): void { writeVarint((field << 3) | wire, out) }
function lenField(field: number, bytes: number[], out: number[]): void {
  tag(field, 2, out); writeVarint(bytes.length, out); for (const b of bytes) out.push(b)
}
function strBytes(s: string): number[] { return [...new TextEncoder().encode(s)] }

// MediaSessionDcBigPacket: subscribe to captions in `lang`.
function buildSubscribe(op: number, lang: string): Uint8Array {
  const captionConfig: number[] = []
  lenField(1, strBytes(lang), captionConfig) // lang_1
  lenField(2, strBytes(lang), captionConfig) // lang_2
  const clientConfig: number[] = []
  lenField(9, captionConfig, clientConfig)
  const updateMask: number[] = []
  lenField(1, strBytes("client_config.caption_config"), updateMask)
  const captionUpdate: number[] = []
  lenField(1, clientConfig, captionUpdate)
  lenField(2, updateMask, captionUpdate)
  const command: number[] = []
  tag(1, 0, command); writeVarint(op, command) // op
  lenField(3, captionUpdate, command)
  const envelope: number[] = []
  lenField(2, command, envelope)
  const packet: number[] = []
  lenField(1, envelope, packet)
  return new Uint8Array(packet)
}

// MediaSessionDcSmallPacket: ack(seq, ok=1).
function buildAck(seq: number): Uint8Array {
  const ack: number[] = []
  tag(2, 0, ack); writeVarint(seq, ack)
  tag(3, 0, ack); writeVarint(1, ack)
  const envelope: number[] = []
  lenField(1, ack, envelope)
  const packet: number[] = []
  lenField(1, envelope, packet)
  return new Uint8Array(packet)
}

// Track Meet's own op (big packet) / seq (small packet) counters from outgoing sends.
function readNestedOp(buf: Uint8Array): number | undefined {
  // packet.field1(env).field2(command).field1(op)
  const c: Cursor = { buf, i: 0 }
  try {
    if (readTag(c).field !== 1) return undefined
    const envLen = readVarint(c); const envEnd = c.i + envLen
    while (c.i < envEnd) { const t = readTag(c); if (t.field === 2 && t.wire === 2) {
      const cmdLen = readVarint(c); const cmdEnd = c.i + cmdLen
      while (c.i < cmdEnd) { const t2 = readTag(c); if (t2.field === 1 && t2.wire === 0) return readVarint(c); skip(c, t2.wire) }
    } else skip(c, t.wire) }
  } catch { /* not a big packet */ }
  return undefined
}
function readNestedSeq(buf: Uint8Array): number | undefined {
  // packet.field1(env).field1(ack).field2(seq)
  const c: Cursor = { buf, i: 0 }
  try {
    if (readTag(c).field !== 1) return undefined
    const envLen = readVarint(c); const envEnd = c.i + envLen
    while (c.i < envEnd) { const t = readTag(c); if (t.field === 1 && t.wire === 2) {
      const ackLen = readVarint(c); const ackEnd = c.i + ackLen
      while (c.i < ackEnd) { const t2 = readTag(c); if (t2.field === 2 && t2.wire === 0) return readVarint(c); skip(c, t2.wire) }
    } else skip(c, t.wire) }
  } catch { /* not a small packet */ }
  return undefined
}

// ---------- gzip-aware payload normalization ----------

function isGzip(u: Uint8Array): boolean { return u.length > 2 && u[0] === 0x1f && u[1] === 0x8b && u[2] === 0x08 }

async function toBytes(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data)
  let gz: Uint8Array | null = null
  if (isGzip(u)) gz = u
  else if (isGzip(u.slice(3))) gz = u.slice(3)
  if (!gz) return u
  try {
    const ds = new DecompressionStream("gzip")
    const ab = await new Response(new Blob([gz as unknown as BlobPart]).stream().pipeThrough(ds)).arrayBuffer()
    return new Uint8Array(ab)
  } catch { return u }
}

// ---------- RTCPeerConnection hooks ----------

let opCounter = 0
let seqCounter = 0
let pc: RTCPeerConnection | null = null
let mediaSession: RTCDataChannel | null = null
let subscribed = false

function attachCaptions(ch: RTCDataChannel): void {
  emit({ phase: "captions-attached", state: ch.readyState })
  ch.addEventListener("message", (e: MessageEvent) => {
    void (async () => {
      try {
        const bytes = await toBytes(e.data as ArrayBuffer)
        const m = decodeTranscriptWrapper(bytes)
        if (m?.text) emit({ phase: "transcript", text: m.text.slice(0, 140), langId: m.langId, deviceId: m.deviceId })
      } catch (err) { emit({ phase: "decode-error", error: String(err) }) }
    })()
  })
}

// A Meet data channel can be created locally (createDataChannel) or arrive
// remotely (ondatachannel); handle every label from both directions.
function handleChannel(ch: RTCDataChannel): void {
  if (ch.label === "captions") { attachCaptions(ch); return }
  if (ch.label === "media-session") {
    mediaSession = ch
    emit({ phase: "media-session", state: ch.readyState })
    if (ch.readyState === "open") setTimeout(trySubscribe, 1500)
    ch.addEventListener("open", () => setTimeout(trySubscribe, 1500))
    return
  }
  if (ch.label === "collections") emit({ phase: "collections", state: ch.readyState })
  else if (ch.label === "meet_messages") emit({ phase: "meet_messages", state: ch.readyState })
}

function trySubscribe(): void {
  if (subscribed || !pc) return
  if (!mediaSession || mediaSession.readyState !== "open") return
  subscribed = true
  try {
    pc.createDataChannel("captions", { ordered: true, maxRetransmits: 10, id: 50001 })
  } catch (err) { emit({ phase: "create-captions-error", error: String(err) }) }
  try {
    mediaSession.send(buildSubscribe(opCounter + 1, SPIKE_LANG) as unknown as ArrayBuffer)
    mediaSession.send(buildAck(seqCounter + 1) as unknown as ArrayBuffer)
    mediaSession.send(buildAck(seqCounter + 2) as unknown as ArrayBuffer)
    emit({ phase: "subscribe-sent", op: opCounter + 1, lang: SPIKE_LANG })
  } catch (err) { emit({ phase: "subscribe-error", error: String(err) }) }
}

function install(): boolean {
  const w = window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection; __platicaSpike?: boolean }
  if (!w.RTCPeerConnection || w.__platicaSpike) return false
  w.__platicaSpike = true

  // Track op/seq from Meet's outgoing media-session packets.
  const origSend = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
    try {
      if (this.label === "media-session" && data instanceof ArrayBuffer) {
        const u = new Uint8Array(data)
        const op = readNestedOp(u); if (op !== undefined) opCounter = op
        const seq = readNestedSeq(u); if (seq !== undefined) seqCounter = seq
      }
    } catch { /* best-effort counters */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origSend as any).apply(this, arguments as any)
  }

  // Catch channels Meet (or we) create locally.
  const origCreate = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, label: string, ...rest: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ch = (origCreate as any).apply(this, [label, ...rest])
    emit({ phase: "createDataChannel", label })
    handleChannel(ch)
    return ch
  }

  const OrigPC = w.RTCPeerConnection
  const Wrapped = function (this: unknown, ...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn: RTCPeerConnection = new (OrigPC as any)(...args)
    pc = conn
    emit({ phase: "pc-created" })
    conn.addEventListener("datachannel", (ev: RTCDataChannelEvent) => {
      emit({ phase: "ondatachannel", label: ev.channel.label })
      handleChannel(ev.channel)
    })
    return conn
  } as unknown as typeof RTCPeerConnection
  Wrapped.prototype = OrigPC.prototype
  w.RTCPeerConnection = Wrapped

  emit({ phase: "installed", rtc: typeof OrigPC })
  return true
}

if (!install()) emit({ phase: "install-skipped", rtc: typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection })
