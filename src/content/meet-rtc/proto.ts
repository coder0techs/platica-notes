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
  // Meet's numeric caption-language id (field 8). Captured for diagnostics of
  // multi-language meetings; not yet rendered into the saved transcript.
  langId?: number
}

export interface ChatPayload {
  deviceId?: string
  text?: string
  sender?: string
  // Stable per-message resource name ("spaces/…/messages/…"), field 1 of the
  // message node. Used to dedupe: the collections channel re-syncs messages, so
  // the same message can arrive in more than one packet.
  messageId?: string
}

export interface RosterEntry {
  deviceId: string
  deviceName: string
}

// ---------- protobuf cursor helpers ----------

interface Cursor { buf: Uint8Array; i: number }

// Sentinel thrown by skip() on unknown wire types so the public decoder can abort
// rather than silently misparsing the rest of the message.
const UNKNOWN_WIRE = Symbol("unknown_wire")

// Clamp a wire-declared length so walk loops never run past the real buffer end,
// even when a truncated or hostile packet declares a length larger than the data.
function boundedEnd(c: Cursor, l: number): number {
  return Math.min(c.i + l, c.buf.length)
}

// Use multiplication rather than bit-shifts: JS `>>` coerces operands to Int32,
// so shift >= 32 silently wraps and corrupts values above 2^31.
// Guard against buffer ending mid-varint: a read past the end returns undefined;
// (undefined & 0x7f) === 0 and (undefined & 0x80) === 0 breaks on the first
// undefined byte (safe for a single read), but we also check the index bound so
// a series of adjacent truncated messages cannot extend the loop via the tag read.
function readVarint(c: Cursor): number {
  let result = 0
  let shift = 0
  while (c.i < c.buf.length) {
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

// Wire types 3/4/6/7 are undefined in proto3 (group start/end are deprecated in
// proto3 and illegal in new schemas).  Encountering one means the message is
// unparseable from this point — throw so the public boundary can abort cleanly.
function skip(c: Cursor, wire: number): void {
  if (wire === 0) readVarint(c)
  else if (wire === 2) c.i = boundedEnd(c, readVarint(c))
  else if (wire === 5) c.i += 4
  else if (wire === 1) c.i += 8
  else throw UNKNOWN_WIRE
}

const decoder = new TextDecoder()

function readString(c: Cursor): string {
  const l = readVarint(c)
  const end = boundedEnd(c, l)
  const s = decoder.decode(c.buf.slice(c.i, end))
  c.i = end
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
  // Clamp end so a caller passing an oversized bound cannot walk past the buffer.
  const safeEnd = Math.min(end, buf.length)
  const c: Cursor = { buf, i: start }
  const out: Transcript = {}
  while (c.i < safeEnd) {
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
// try/catch: skip() throws UNKNOWN_WIRE on malformed input; we treat that as "not a transcript".
export function decodeTranscriptWrapper(buf: Uint8Array): Transcript | null {
  try {
    const c: Cursor = { buf, i: 0 }
    let message: Transcript | null = null
    let hasUnknown2 = false
    while (c.i < buf.length) {
      const { field, wire } = readTag(c)
      if (field === 1 && wire === 2) {
        const l = readVarint(c)
        const end = boundedEnd(c, l)
        message = decodeTranscriptMessage(buf, c.i, end)
        c.i = end
      } else if (field === 2 && wire === 2) {
        hasUnknown2 = true
        skip(c, wire)
      } else {
        skip(c, wire)
      }
    }
    return hasUnknown2 ? null : message
  } catch {
    return null
  }
}

// ---------- chat message-node decoder ----------

// The chat message node (all len-delim unless noted), live-verified on the wire:
//   message: f1=resource id ("spaces/…/messages/…"), f2=deviceId(string),
//            f5={f1=text(string)}, f8={f1=sender display name(string)}
// Other fields (f3 timestamp, f4 sub, f6, f10) are skipped. This node shape is
// stable; only its transport envelope changed (see decodeCollectionsChat). The id
// (f1) is the stable dedup key — the collections channel replays messages.

// Read the f1 sub-string of a len-delimited submessage (used for both text f5.f1 and
// sender f8.f1). Tolerates unknown fields and truncation via boundedEnd.
function firstSubString(buf: Uint8Array, start: number, end: number): string | undefined {
  const safeEnd = Math.min(end, buf.length)
  const c: Cursor = { buf, i: start }
  let value: string | undefined
  while (c.i < safeEnd) {
    const { field, wire } = readTag(c)
    if (field === 1 && wire === 2 && value === undefined) value = readString(c)
    else skip(c, wire)
  }
  return value
}

function decodeChatMessage(buf: Uint8Array, start: number, end: number): ChatPayload {
  // Clamp end so a caller passing an oversized bound cannot walk past the buffer.
  const safeEnd = Math.min(end, buf.length)
  const c: Cursor = { buf, i: start }
  const out: ChatPayload = {}
  while (c.i < safeEnd) {
    const { field, wire } = readTag(c)
    if (field === 1 && wire === 2) out.messageId = readString(c)
    else if (field === 2 && wire === 2) out.deviceId = readString(c)
    else if (field === 5 && wire === 2) {
      const subLen = readVarint(c)
      const subEnd = boundedEnd(c, subLen)
      out.text = firstSubString(buf, c.i, subEnd)
      c.i = subEnd
    } else if (field === 8 && wire === 2) {
      const subLen = readVarint(c)
      const subEnd = boundedEnd(c, subLen)
      out.sender = firstSubString(buf, c.i, subEnd)
      c.i = subEnd
    } else {
      skip(c, wire)
    }
  }
  return out
}

function walkLen(c: Cursor, end: number, targetField: number): { start: number; end: number } | null {
  // Clamp the walk bound so a hostile declared length cannot extend past the buffer.
  const safeEnd = Math.min(end, c.buf.length)
  while (c.i < safeEnd) {
    const { field, wire } = readTag(c)
    if (field === targetField && wire === 2) {
      const l = readVarint(c)
      const fieldEnd = boundedEnd(c, l)
      return { start: c.i, end: fieldEnd }
    }
    skip(c, wire)
  }
  return null
}

// ---------- collections-channel chat decoder ----------

// Google Meet moved chat off the meet_messages data channel onto the collections
// channel (the same one that carries the roster), delivered as a meeting-space-
// collections update backed by Google Chat. Live-verified nesting:
//   root.f1 → f2 → f13 → f4 (messages collection) → { f1 = metadata; repeated f2 = message }
// Each message node has the SAME shape decodeChatMessage already handles
// (f1 = resource id, f2 = deviceId, f5.f1 = text, f8.f1 = sender); devices arrive
// under the sibling f13 → f1 branch (handled by decodeRoster), so a device-only
// update yields no messages here. Returns every message in the packet (the
// collection can batch/replay several); callers dedupe by messageId.
export function decodeCollectionsChat(buf: Uint8Array): ChatPayload[] {
  const out: ChatPayload[] = []
  try {
    const c: Cursor = { buf, i: 0 }
    const s1 = walkLen(c, buf.length, 1); if (!s1) return out
    const c1: Cursor = { buf, i: s1.start }
    const s2 = walkLen(c1, s1.end, 2); if (!s2) return out
    const c2: Cursor = { buf, i: s2.start }
    const s13 = walkLen(c2, s2.end, 13); if (!s13) return out
    const c13: Cursor = { buf, i: s13.start }
    const s4 = walkLen(c13, s13.end, 4); if (!s4) return out
    // Read the repeated f2 message entries inside the messages collection.
    const c4: Cursor = { buf, i: s4.start }
    const safeEnd = Math.min(s4.end, buf.length)
    while (c4.i < safeEnd) {
      const { field, wire } = readTag(c4)
      if (field === 2 && wire === 2) {
        const l = readVarint(c4)
        const end = boundedEnd(c4, l)
        const msg = decodeChatMessage(buf, c4.i, end)
        c4.i = end
        // Drop entries lacking the essentials (matches the old chat guard).
        if (msg.deviceId && msg.text) out.push(msg)
      } else {
        skip(c4, wire)
      }
    }
  } catch {
    /* tolerate malformed input — return whatever decoded cleanly */
  }
  return out
}

// ---------- outgoing (own) chat decoder ----------

// The local user's own chat is never echoed back to this client (the collections
// channel only carries OTHER participants' messages), so it exists only as an
// OUTGOING send on the meet_messages channel. Live-verified nesting of that send:
//   root.f1 → f1 → f3 → f1 → f2 (message) → { f3 = client ts; f5 = {f1 = text}; f6 }
// It carries neither deviceId nor sender nor a server message id — the caller
// attributes the text to the local user and dedupes on the client timestamp.
export function decodeOutgoingChat(buf: Uint8Array): { text: string; sentAt?: number } | null {
  try {
    const c: Cursor = { buf, i: 0 }
    const a = walkLen(c, buf.length, 1); if (!a) return null
    const ca: Cursor = { buf, i: a.start }
    const b = walkLen(ca, a.end, 1); if (!b) return null
    const cb: Cursor = { buf, i: b.start }
    const d = walkLen(cb, b.end, 3); if (!d) return null
    const cd: Cursor = { buf, i: d.start }
    const e = walkLen(cd, d.end, 1); if (!e) return null
    const ce: Cursor = { buf, i: e.start }
    const node = walkLen(ce, e.end, 2); if (!node) return null
    // Within the message node: f5 = {f1 = text}, f3 = client timestamp.
    const cn: Cursor = { buf, i: node.start }
    const safeEnd = Math.min(node.end, buf.length)
    let text: string | undefined
    let sentAt: number | undefined
    while (cn.i < safeEnd) {
      const { field, wire } = readTag(cn)
      if (field === 5 && wire === 2) {
        const l = readVarint(cn)
        const end = boundedEnd(cn, l)
        text = firstSubString(buf, cn.i, end)
        cn.i = end
      } else if (field === 3 && wire === 0) {
        sentAt = readVarint(cn)
      } else {
        skip(cn, wire)
      }
    }
    if (!text) return null
    return sentAt === undefined ? { text } : { text, sentAt }
  } catch {
    return null
  }
}

// ---------- roster decoder ----------

// Leaf: field 1 = deviceId(string), field 2 = deviceName(string)
function decodeLeaf(buf: Uint8Array, start: number, end: number): RosterEntry | null {
  // Clamp end so a caller passing an oversized bound cannot walk past the buffer.
  const safeEnd = Math.min(end, buf.length)
  const c: Cursor = { buf, i: start }
  let deviceId: string | undefined
  let deviceName: string | undefined
  while (c.i < safeEnd) {
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
      const leafEnd = boundedEnd(c2, l)
      const entry = decodeLeaf(buf, c2.i, leafEnd)
      c2.i = leafEnd
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

// A participant LEAVING arrives on the same collections channel, at the same
// nesting as the single-device form (outer.f1 → f2 → f13 → f1), but the device is
// a BARE deviceId string at f3 with NO name leaf (live-verified wire form; a join
// instead carries the device under an f2 leaf {f1=id, f2=name}). decodeRoster
// requires a name so it silently drops these — this reads the removal. The sibling
// f1 submessage carries a state enum (46=removed vs 43=present) we do not rely on;
// the bare f3 id (no f2 leaf) is the discriminator. Returns removed deviceId(s);
// tolerant of malformed input.
export function decodeRosterLeave(buf: Uint8Array): string[] {
  const out: string[] = []
  try {
    const c: Cursor = { buf, i: 0 }
    const s1 = walkLen(c, buf.length, 1); if (!s1) return out
    const c1: Cursor = { buf, i: s1.start }
    const s2 = walkLen(c1, s1.end, 2); if (!s2) return out
    const c2: Cursor = { buf, i: s2.start }
    const s13 = walkLen(c2, s2.end, 13); if (!s13) return out
    const c13: Cursor = { buf, i: s13.start }
    const node = walkLen(c13, s13.end, 1); if (!node) return out
    // Within f13.f1: f3 is the removed deviceId (bare string). Absent on joins,
    // which instead carry an f2 leaf here.
    const cNode: Cursor = { buf, i: node.start }
    const idField = walkLen(cNode, node.end, 3)
    if (idField) {
      const id = decoder.decode(buf.slice(idField.start, Math.min(idField.end, buf.length)))
      if (id) out.push(id)
    }
  } catch { /* tolerate malformed */ }
  return out
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
    const envLen = readVarint(c); const envEnd = boundedEnd(c, envLen)
    while (c.i < envEnd) {
      const t = readTag(c)
      if (t.field === 2 && t.wire === 2) {
        const cmdLen = readVarint(c); const cmdEnd = boundedEnd(c, cmdLen)
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
    const envLen = readVarint(c); const envEnd = boundedEnd(c, envLen)
    while (c.i < envEnd) {
      const t = readTag(c)
      if (t.field === 1 && t.wire === 2) {
        const ackLen = readVarint(c); const ackEnd = boundedEnd(c, ackLen)
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
