// Pure protobuf codec for Google Meet WebRTC data channels.
// No DOM/chrome/window dependencies — only Web Streams APIs (DecompressionStream,
// Response, Blob) which are available in Chrome and Node >= 18.
//
// Clean reimplementation against Google Meet's wire format. Not derived from any
// third-party source code; only the public protocol shape is used.

// ---------- types ----------

export interface Transcript {
  deviceId?: string
  messageId?: number
  messageVersion?: number
  text?: string
  langId?: number
}

export interface ChatPayload {
  deviceId?: string
  timestamp?: number
  text?: string
}

export interface RosterEntry {
  deviceId: string
  deviceName: string
}

// ---------- protobuf cursor helpers ----------

interface Cursor { buf: Uint8Array; i: number }

// Use multiplication rather than bit-shifts: JS `>>` coerces operands to Int32,
// so shift >= 32 silently wraps and corrupts values above 2^31.
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

function readString(c: Cursor): string {
  const l = readVarint(c)
  const s = decoder.decode(c.buf.slice(c.i, c.i + l))
  c.i += l
  return s
}

// ---------- protobuf writer helpers ----------

function writeVarint(n: number, out: number[]): void {
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) }
  out.push(n)
}

function tag(field: number, wire: number, out: number[]): void {
  writeVarint((field << 3) | wire, out)
}

function lenField(field: number, bytes: number[], out: number[]): void {
  tag(field, 2, out)
  writeVarint(bytes.length, out)
  for (const b of bytes) out.push(b)
}

function strBytes(s: string): number[] { return [...new TextEncoder().encode(s)] }

// ---------- transcript decoder ----------

function decodeTranscriptMessage(buf: Uint8Array, start: number, end: number): Transcript {
  const c: Cursor = { buf, i: start }
  const out: Transcript = {}
  while (c.i < end) {
    const { field, wire } = readTag(c)
    if (field === 1 && wire === 2) out.deviceId = readString(c)
    else if (field === 2 && wire === 0) out.messageId = readVarint(c)
    else if (field === 3 && wire === 0) out.messageVersion = readVarint(c)
    else if (field === 6 && wire === 2) out.text = readString(c)
    else if (field === 8 && wire === 0) out.langId = readVarint(c)
    else skip(c, wire)
  }
  return out
}

// Wrapper: field 1 = message (len-delim); field 2 = unknown2 (presence → not a transcript).
export function decodeTranscriptWrapper(buf: Uint8Array): Transcript | null {
  const c: Cursor = { buf, i: 0 }
  let message: Transcript | null = null
  let hasUnknown2 = false
  while (c.i < buf.length) {
    const { field, wire } = readTag(c)
    if (field === 1 && wire === 2) {
      const l = readVarint(c)
      message = decodeTranscriptMessage(buf, c.i, c.i + l)
      c.i += l
    } else if (field === 2 && wire === 2) {
      hasUnknown2 = true
      skip(c, wire)
    } else {
      skip(c, wire)
    }
  }
  return hasUnknown2 ? null : message
}

// ---------- chat decoder ----------

// Chat nesting (all len-delim):
// wrapper.f1 → l1.f2 → l2.f13 → l3.f4 → l4.f2 → message
// message: f2=deviceId(string), f3=timestamp(varint), f5={f1=text(string)}

function decodeChatMessage(buf: Uint8Array, start: number, end: number): ChatPayload {
  const c: Cursor = { buf, i: start }
  const out: ChatPayload = {}
  while (c.i < end) {
    const { field, wire } = readTag(c)
    if (field === 2 && wire === 2) out.deviceId = readString(c)
    else if (field === 3 && wire === 0) out.timestamp = readVarint(c)
    else if (field === 5 && wire === 2) {
      // text submessage: field 1 = value(string)
      const subLen = readVarint(c)
      const subEnd = c.i + subLen
      const sc: Cursor = { buf, i: c.i }
      while (sc.i < subEnd) {
        const { field: sf, wire: sw } = readTag(sc)
        if (sf === 1 && sw === 2) out.text = readString(sc)
        else skip(sc, sw)
      }
      c.i = subEnd
    } else {
      skip(c, wire)
    }
  }
  return out
}

function walkLen(c: Cursor, end: number, targetField: number): { start: number; end: number } | null {
  while (c.i < end) {
    const { field, wire } = readTag(c)
    if (field === targetField && wire === 2) {
      const l = readVarint(c)
      return { start: c.i, end: c.i + l }
    }
    skip(c, wire)
  }
  return null
}

export function decodeChatWrapper(buf: Uint8Array): ChatPayload | null {
  try {
    const c: Cursor = { buf, i: 0 }
    const l1 = walkLen(c, buf.length, 1); if (!l1) return null
    const c1: Cursor = { buf, i: l1.start }
    const l2 = walkLen(c1, l1.end, 2); if (!l2) return null
    const c2: Cursor = { buf, i: l2.start }
    const l3 = walkLen(c2, l2.end, 13); if (!l3) return null
    const c3: Cursor = { buf, i: l3.start }
    const l4 = walkLen(c3, l3.end, 4); if (!l4) return null
    const c4: Cursor = { buf, i: l4.start }
    const msg = walkLen(c4, l4.end, 2); if (!msg) return null
    return decodeChatMessage(buf, msg.start, msg.end)
  } catch {
    return null
  }
}

// ---------- roster decoder ----------

// Leaf: field 1 = deviceId(string), field 2 = deviceName(string)
function decodeLeaf(buf: Uint8Array, start: number, end: number): RosterEntry | null {
  const c: Cursor = { buf, i: start }
  let deviceId: string | undefined
  let deviceName: string | undefined
  while (c.i < end) {
    const { field, wire } = readTag(c)
    if (field === 1 && wire === 2) deviceId = readString(c)
    else if (field === 2 && wire === 2) deviceName = readString(c)
    else skip(c, wire)
  }
  if (deviceId === undefined || deviceName === undefined) return null
  return { deviceId, deviceName }
}

// Collection form: outer.f2 → l1.f2 → l2.REPEATED f2 = leaf
function collectFromCollectionForm(buf: Uint8Array, results: RosterEntry[]): void {
  const c: Cursor = { buf, i: 0 }
  const l1 = walkLen(c, buf.length, 2); if (!l1) return
  const c1: Cursor = { buf, i: l1.start }
  const l2 = walkLen(c1, l1.end, 2); if (!l2) return
  const c2: Cursor = { buf, i: l2.start }
  // read repeated field 2 leaves
  while (c2.i < l2.end) {
    const { field, wire } = readTag(c2)
    if (field === 2 && wire === 2) {
      const l = readVarint(c2)
      const entry = decodeLeaf(buf, c2.i, c2.i + l)
      c2.i += l
      if (entry) results.push(entry)
    } else {
      skip(c2, wire)
    }
  }
}

// Single-device form: outer.f1 → s1.f2 → s2.f13 → s3.f1 → s4.f2 = leaf
function collectFromSingleForm(buf: Uint8Array, results: RosterEntry[]): void {
  const c: Cursor = { buf, i: 0 }
  const s1 = walkLen(c, buf.length, 1); if (!s1) return
  const c1: Cursor = { buf, i: s1.start }
  const s2 = walkLen(c1, s1.end, 2); if (!s2) return
  const c2: Cursor = { buf, i: s2.start }
  const s3 = walkLen(c2, s2.end, 13); if (!s3) return
  const c3: Cursor = { buf, i: s3.start }
  const s4 = walkLen(c3, s3.end, 1); if (!s4) return
  const c4: Cursor = { buf, i: s4.start }
  const leaf = walkLen(c4, s4.end, 2); if (!leaf) return
  const entry = decodeLeaf(buf, leaf.start, leaf.end)
  if (entry) results.push(entry)
}

export function decodeRoster(buf: Uint8Array): RosterEntry[] {
  const results: RosterEntry[] = []
  try { collectFromCollectionForm(buf, results) } catch { /* tolerate malformed */ }
  try { collectFromSingleForm(buf, results) } catch { /* tolerate malformed */ }
  return results
}

// ---------- subscribe / ack builders ----------

// MediaSessionDcBigPacket: subscribe to captions in `lang`.
export function buildSubscribe(op: number, lang: string): Uint8Array {
  const captionConfig: number[] = []
  lenField(1, strBytes(lang), captionConfig)  // lang_1
  lenField(2, strBytes(lang), captionConfig)  // lang_2
  const clientConfig: number[] = []
  lenField(9, captionConfig, clientConfig)
  const updateMask: number[] = []
  lenField(1, strBytes("client_config.caption_config"), updateMask)
  const captionUpdate: number[] = []
  lenField(1, clientConfig, captionUpdate)
  lenField(2, updateMask, captionUpdate)
  const command: number[] = []
  tag(1, 0, command); writeVarint(op, command)  // op
  lenField(3, captionUpdate, command)
  const envelope: number[] = []
  lenField(2, command, envelope)
  const packet: number[] = []
  lenField(1, envelope, packet)
  return new Uint8Array(packet)
}

// MediaSessionDcSmallPacket: ack(seq, ok=1).
export function buildAck(seq: number): Uint8Array {
  const ack: number[] = []
  tag(2, 0, ack); writeVarint(seq, ack)
  tag(3, 0, ack); writeVarint(1, ack)
  const envelope: number[] = []
  lenField(1, ack, envelope)
  const packet: number[] = []
  lenField(1, envelope, packet)
  return new Uint8Array(packet)
}

// ---------- counter readers for Meet's outgoing media-session packets ----------

// packet.field1(env).field2(command).field1(op)
export function readNestedOp(buf: Uint8Array): number | undefined {
  const c: Cursor = { buf, i: 0 }
  try {
    if (readTag(c).field !== 1) return undefined
    const envLen = readVarint(c); const envEnd = c.i + envLen
    while (c.i < envEnd) {
      const t = readTag(c)
      if (t.field === 2 && t.wire === 2) {
        const cmdLen = readVarint(c); const cmdEnd = c.i + cmdLen
        while (c.i < cmdEnd) {
          const t2 = readTag(c)
          if (t2.field === 1 && t2.wire === 0) return readVarint(c)
          skip(c, t2.wire)
        }
      } else { skip(c, t.wire) }
    }
  } catch { /* not a big packet */ }
  return undefined
}

// packet.field1(env).field1(ack).field2(seq)
export function readNestedSeq(buf: Uint8Array): number | undefined {
  const c: Cursor = { buf, i: 0 }
  try {
    if (readTag(c).field !== 1) return undefined
    const envLen = readVarint(c); const envEnd = c.i + envLen
    while (c.i < envEnd) {
      const t = readTag(c)
      if (t.field === 1 && t.wire === 2) {
        const ackLen = readVarint(c); const ackEnd = c.i + ackLen
        while (c.i < ackEnd) {
          const t2 = readTag(c)
          if (t2.field === 2 && t2.wire === 0) return readVarint(c)
          skip(c, t2.wire)
        }
      } else { skip(c, t.wire) }
    }
  } catch { /* not a small packet */ }
  return undefined
}

// ---------- gzip-aware payload normalization ----------

function isGzip(u: Uint8Array): boolean {
  return u.length > 2 && u[0] === 0x1f && u[1] === 0x8b && u[2] === 0x08
}

export async function toBytes(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data)
  let gz: Uint8Array | null = null
  if (isGzip(u)) gz = u
  else if (u.length > 5 && isGzip(u.slice(3))) gz = u.slice(3)
  if (!gz) return u
  try {
    const ds = new DecompressionStream("gzip")
    const ab = await new Response(new Blob([gz as unknown as BlobPart]).stream().pipeThrough(ds)).arrayBuffer()
    return new Uint8Array(ab)
  } catch { return u }
}
