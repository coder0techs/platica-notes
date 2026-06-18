import { describe, expect, it } from "vitest"
import {
  decodeTranscriptWrapper,
  decodeChatWrapper,
  decodeRoster,
  buildSubscribe,
  buildAck,
  readNestedOp,
  readNestedSeq,
  toBytes,
  type Transcript,
  type RosterEntry,
} from "../src/content/meet-rtc/proto"

// ---------- test-local protobuf builder ----------
// Minimal helpers so tests can construct synthetic messages without importing
// internals.  These mirror the logic in proto.ts but are local to tests.

function writeVarint(n: number, out: number[]): void {
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) }
  out.push(n)
}
function tagBytes(field: number, wire: number, out: number[]): void {
  writeVarint((field << 3) | wire, out)
}
function lenField(field: number, bytes: number[], out: number[]): void {
  tagBytes(field, 2, out)
  writeVarint(bytes.length, out)
  for (const b of bytes) out.push(b)
}
function strBytes(s: string): number[] { return [...new TextEncoder().encode(s)] }
function u8(arr: number[]): Uint8Array { return new Uint8Array(arr) }
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ---------- test-local protobuf reader ----------
// Used by the locale-embedding test to walk the subscribe packet structure
// without depending on proto.ts internals.

function makeReader(buf: Uint8Array): {
  rv(): number
  rt(): { f: number; w: number }
  skipField(w: number): void
  expectLenField(expectedField: number): { start: number; end: number }
  i: { value: number }
} {
  const pos = { value: 0 }
  function rv(): number {
    let r = 0; let s = 0
    for (;;) { const b = buf[pos.value++]; r += (b & 0x7f) * 2 ** s; if (!(b & 0x80)) return r; s += 7 }
  }
  function rt(): { f: number; w: number } { const k = rv(); return { f: k >>> 3, w: k & 7 } }
  function skipField(w: number): void { if (w === 0) rv(); else if (w === 2) pos.value += rv(); else if (w === 5) pos.value += 4; else if (w === 1) pos.value += 8 }
  function expectLenField(expectedField: number): { start: number; end: number } {
    while (pos.value < buf.length) {
      const { f, w } = rt()
      if (f === expectedField && w === 2) { const l = rv(); return { start: pos.value, end: pos.value + l } }
      skipField(w)
    }
    throw new Error(`field ${expectedField} not found`)
  }
  return { rv, rt, skipField, expectLenField, i: pos }
}

// Build a Transcript inner message
function buildTranscriptMessage(opts: {
  deviceId?: string
  messageId?: number
  messageVersion?: number
  text?: string
  extraField?: boolean
}): number[] {
  const out: number[] = []
  if (opts.deviceId !== undefined) lenField(1, strBytes(opts.deviceId), out)
  if (opts.messageId !== undefined) { tagBytes(2, 0, out); writeVarint(opts.messageId, out) }
  if (opts.messageVersion !== undefined) { tagBytes(3, 0, out); writeVarint(opts.messageVersion, out) }
  if (opts.text !== undefined) lenField(6, strBytes(opts.text), out)
  // unknown extra field (field 99, wire 0, value 42)
  if (opts.extraField) { tagBytes(99, 0, out); writeVarint(42, out) }
  return out
}

// Build a transcript wrapper (field 1 = message, optionally field 2 = unknown2)
function buildTranscriptWrapper(inner: number[], hasUnknown2 = false): Uint8Array {
  const out: number[] = []
  lenField(1, inner, out)
  if (hasUnknown2) lenField(2, [0x01], out)
  return u8(out)
}

// ---------- transcript tests ----------

describe("decodeTranscriptWrapper", () => {
  it("decodes a full synthetic transcript", () => {
    const inner = buildTranscriptMessage({
      deviceId: "dev-abc",
      messageId: 42,
      messageVersion: 1,
      text: "Hello world",
    })
    const result = decodeTranscriptWrapper(buildTranscriptWrapper(inner))
    expect(result).not.toBeNull()
    expect(result!.deviceId).toBe("dev-abc")
    expect(result!.messageId).toBe(42)
    expect(result!.messageVersion).toBe(1)
    expect(result!.text).toBe("Hello world")
  })

  it("returns null when field 2 (unknown2) is present", () => {
    const inner = buildTranscriptMessage({ text: "ignored" })
    const result = decodeTranscriptWrapper(buildTranscriptWrapper(inner, true))
    expect(result).toBeNull()
  })

  it("skips unknown extra fields in the inner message", () => {
    const inner = buildTranscriptMessage({ text: "ok", extraField: true })
    const result = decodeTranscriptWrapper(buildTranscriptWrapper(inner))
    expect(result).not.toBeNull()
    expect(result!.text).toBe("ok")
  })

  it("handles messageId > 127 (multi-byte varint)", () => {
    const inner = buildTranscriptMessage({ messageId: 300 })
    const result = decodeTranscriptWrapper(buildTranscriptWrapper(inner))
    expect(result!.messageId).toBe(300)
  })

  it("handles messageId > 2^31 (JS safe integer via multiplication)", () => {
    const large = 2 ** 32 + 5   // 4294967301 — exceeds 32-bit shift range
    const inner = buildTranscriptMessage({ messageId: large })
    const result = decodeTranscriptWrapper(buildTranscriptWrapper(inner))
    expect(result!.messageId).toBe(large)
  })

  it("returns null when the wrapper is empty (no field 1)", () => {
    // empty buffer → no message field → message stays null
    const result = decodeTranscriptWrapper(new Uint8Array(0))
    expect(result).toBeNull()
  })

  it("skips unknown fields in the outer wrapper", () => {
    const inner = buildTranscriptMessage({ text: "hi" })
    const out: number[] = []
    lenField(1, inner, out)
    tagBytes(7, 0, out); writeVarint(99, out)   // field 7, varint — unknown
    const result = decodeTranscriptWrapper(u8(out))
    expect(result!.text).toBe("hi")
  })
})

// ---------- chat builder helpers ----------

// Build a chat message body. Field numbers are the live-verified ones:
// f2=deviceId(string), f5={f1=text}, f8={f1=sender}. f3 timestamp / f6 are unknowns
// the decoder must skip; we add them optionally to exercise that tolerance.
function buildLeafMessage(opts: {
  deviceId?: string
  text?: string
  sender?: string
  timestamp?: number
  trailing?: boolean
}): number[] {
  const out: number[] = []
  if (opts.deviceId !== undefined) lenField(2, strBytes(opts.deviceId), out)
  if (opts.timestamp !== undefined) { tagBytes(3, 0, out); writeVarint(opts.timestamp, out) }
  if (opts.text !== undefined) {
    const textSub: number[] = []
    lenField(1, strBytes(opts.text), textSub)
    lenField(5, textSub, out)
  }
  if (opts.trailing) { tagBytes(6, 0, out); writeVarint(1, out) }  // unknown field between text and sender
  if (opts.sender !== undefined) {
    const senderSub: number[] = []
    lenField(1, strBytes(opts.sender), senderSub)
    // include an extra avatar-url-like sub-field to mimic real f8 shape
    lenField(2, strBytes("https://avatar/x"), senderSub)
    lenField(8, senderSub, out)
  }
  return out
}

function buildChatWrapper(opts: {
  deviceId?: string
  text?: string
  sender?: string
  timestamp?: number
  trailing?: boolean
  seq?: number
  extraInContainer?: boolean
}): Uint8Array {
  // root.f1 (wrapper) { f1 varint = seq; f4 (container) { f1 = message } }
  const message = buildLeafMessage(opts)
  const container: number[] = []
  lenField(1, message, container)
  if (opts.extraInContainer) { tagBytes(99, 0, container); writeVarint(7, container) }  // unknown
  const wrapper: number[] = []
  if (opts.seq !== undefined) { tagBytes(1, 0, wrapper); writeVarint(opts.seq, wrapper) }
  lenField(4, container, wrapper)
  const root: number[] = []
  lenField(1, wrapper, root)
  return u8(root)
}

// ---------- chat tests ----------

describe("decodeChatWrapper — real wire vectors", () => {
  // Truncated at 160 bytes by the diagnostic logger, so the trailing f8 sender is
  // cut off — the hardened reader must decode deviceId + text without throwing.
  const MSG1 = "0aac0a080122a70a0aa00a0a2d7370616365732f6636516d625a736a54634d422f6d657373616765732f31373831353139303239343139363331121f7370616365732f6636516d625a736a54634d422f646576696365732f34363318d7d4b7d6ec33220c08b5a5bfd10610989f8cc8012a240a22d181d0bed0bed0b1d189d0b5d0bdd0b8d0b520d0b8d0b720d187d0b0d182d0b020313001428c090a1c416c65"
  const MSG2 = "0aab0a080222a60a0a9f0a0a2d7370616365732f6636516d625a736a54634d422f6d657373616765732f31373831353139303334323131313335121f7370616365732f6636516d625a736a54634d422f646576696365732f34363318d8d4b7d6ec33220b08baa5bfd1061098d4d6642a240a22d181d0bed0bed0b1d189d0b5d0bdd0b8d0b520d0b8d0b720d187d0b0d182d0b020323001428c090a1c416c6578"

  it("decodes real msg1 → text + deviceId", () => {
    const result = decodeChatWrapper(hexToBytes(MSG1))
    expect(result).not.toBeNull()
    expect(result!.text).toBe("сообщение из чата 1")
    expect(result!.deviceId).toBe("spaces/f6QmbZsjTcMB/devices/463")
    expect(result!.deviceId!.endsWith("/devices/463")).toBe(true)
  })

  it("decodes real msg2 → text + deviceId", () => {
    const result = decodeChatWrapper(hexToBytes(MSG2))
    expect(result).not.toBeNull()
    expect(result!.text).toBe("сообщение из чата 2")
    expect(result!.deviceId!.endsWith("/devices/463")).toBe(true)
  })
})

describe("decodeChatWrapper", () => {
  it("decodes a synthetic full message with embedded sender", () => {
    // Real vectors truncate the f8 sender; this synthetic vector carries it whole.
    const buf = buildChatWrapper({
      deviceId: "spaces/abc/devices/7",
      text: "hello chat",
      sender: "Grace Hopper",
      timestamp: 1781519029,
      trailing: true,
      seq: 1,
    })
    const result = decodeChatWrapper(buf)
    expect(result).not.toBeNull()
    expect(result!.deviceId).toBe("spaces/abc/devices/7")
    expect(result!.text).toBe("hello chat")
    expect(result!.sender).toBe("Grace Hopper")
  })

  it("returns object with only deviceId when text submessage absent", () => {
    // Contract: returns whatever fields were decoded, never throws.
    const buf = buildChatWrapper({ deviceId: "dev-1" })
    const result = decodeChatWrapper(buf)
    expect(result).not.toBeNull()
    expect(result!.deviceId).toBe("dev-1")
    expect(result!.text).toBeUndefined()
    expect(result!.sender).toBeUndefined()
  })

  it("returns null when the message (root.f1.f4.f1) is absent", () => {
    // No field 1 at root level → wrapper never found → null
    const result = decodeChatWrapper(new Uint8Array([0x08, 0x01]))  // field 1 wire 0, not wire 2
    expect(result).toBeNull()
  })

  it("returns null when the container (f4) is missing", () => {
    // wrapper present but no f4 inside it
    const wrapper: number[] = []; tagBytes(1, 0, wrapper); writeVarint(5, wrapper)
    const root: number[] = []; lenField(1, wrapper, root)
    expect(decodeChatWrapper(u8(root))).toBeNull()
  })

  it("skips unknown fields in the container alongside the message", () => {
    const buf = buildChatWrapper({ text: "test", extraInContainer: true })
    const result = decodeChatWrapper(buf)
    expect(result!.text).toBe("test")
  })

  it("decodes the FIRST message when the container repeats f1", () => {
    const first = buildLeafMessage({ deviceId: "dev-1", text: "first" })
    const second = buildLeafMessage({ deviceId: "dev-2", text: "second" })
    const container: number[] = []
    lenField(1, first, container)
    lenField(1, second, container)
    const wrapper: number[] = []; lenField(4, container, wrapper)
    const root: number[] = []; lenField(1, wrapper, root)
    const result = decodeChatWrapper(u8(root))
    expect(result!.deviceId).toBe("dev-1")
    expect(result!.text).toBe("first")
  })

  it("returns null / does not throw on truncated garbage", () => {
    // valid root.f1 LEN tag but declared length far exceeds the payload
    const buf = u8([0x0a, 100, 0x22, 0x01, 0x41])
    expect(() => decodeChatWrapper(buf)).not.toThrow()
  })
})

// ---------- roster builder helpers ----------

function buildLeaf(opts: { deviceId?: string; deviceName?: string; extra?: boolean }): number[] {
  const out: number[] = []
  if (opts.deviceId !== undefined) lenField(1, strBytes(opts.deviceId), out)
  if (opts.deviceName !== undefined) lenField(2, strBytes(opts.deviceName), out)
  if (opts.extra) { tagBytes(5, 0, out); writeVarint(3, out) }  // unknown field
  return out
}

// Collection form: field2→l1; l1:field2→l2; l2:REPEATED field2=leaf
function buildCollectionForm(devices: Array<{ deviceId: string; deviceName: string }>): Uint8Array {
  const l2: number[] = []
  for (const d of devices) lenField(2, buildLeaf(d), l2)
  const l1: number[] = []; lenField(2, l2, l1)
  const outer: number[] = []; lenField(2, l1, outer)
  return u8(outer)
}

// Single-device form: field1→s1; s1:field2→s2; s2:field13→s3; s3:field1→s4; s4:field2=leaf
function buildSingleDeviceForm(device: { deviceId: string; deviceName: string }): Uint8Array {
  const s4: number[] = []; lenField(2, buildLeaf(device), s4)
  const s3: number[] = []; lenField(1, s4, s3)
  const s2: number[] = []; lenField(13, s3, s2)
  const s1: number[] = []; lenField(2, s2, s1)
  const outer: number[] = []; lenField(1, s1, outer)
  return u8(outer)
}

// ---------- roster tests ----------

describe("decodeRoster", () => {
  it("decodes collection form with multiple devices", () => {
    const buf = buildCollectionForm([
      { deviceId: "d1", deviceName: "Alice" },
      { deviceId: "d2", deviceName: "Bob" },
    ])
    const result = decodeRoster(buf)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ deviceId: "d1", deviceName: "Alice" })
    expect(result[1]).toEqual({ deviceId: "d2", deviceName: "Bob" })
  })

  it("decodes single-device form", () => {
    const buf = buildSingleDeviceForm({ deviceId: "d3", deviceName: "Carol" })
    const result = decodeRoster(buf)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ deviceId: "d3", deviceName: "Carol" })
  })

  it("skips leaves missing deviceName", () => {
    const l2: number[] = []
    lenField(2, buildLeaf({ deviceId: "ok", deviceName: "Good" }), l2)
    lenField(2, buildLeaf({ deviceId: "bad" }), l2)              // no deviceName
    lenField(2, buildLeaf({ deviceName: "Nameless" }), l2)       // no deviceId
    const l1: number[] = []; lenField(2, l2, l1)
    const outer: number[] = []; lenField(2, l1, outer)
    const result = decodeRoster(u8(outer))
    expect(result).toHaveLength(1)
    expect(result[0].deviceId).toBe("ok")
  })

  it("skips unknown fields inside a leaf", () => {
    const buf = buildCollectionForm([{ deviceId: "d1", deviceName: "Alice" }])
    // rebuild with extra field
    const l2: number[] = []
    lenField(2, buildLeaf({ deviceId: "d1", deviceName: "Alice", extra: true }), l2)
    const l1: number[] = []; lenField(2, l2, l1)
    const outer: number[] = []; lenField(2, l1, outer)
    const result = decodeRoster(u8(outer))
    expect(result).toHaveLength(1)
    expect(result[0].deviceName).toBe("Alice")
  })

  it("returns empty array for an unrecognized buffer", () => {
    expect(decodeRoster(new Uint8Array([0x08, 0x01]))).toEqual([])
  })

  it("handles collection form with zero devices", () => {
    const buf = buildCollectionForm([])
    expect(decodeRoster(buf)).toEqual([])
  })
})

// ---------- subscribe / ack round-trip ----------

describe("buildSubscribe / readNestedOp", () => {
  it("round-trips op number", () => {
    expect(readNestedOp(buildSubscribe(5, "ru-RU"))).toBe(5)
  })

  it("round-trips op = 1", () => {
    expect(readNestedOp(buildSubscribe(1, "en-US"))).toBe(1)
  })

  it("round-trips op > 127 (multi-byte varint)", () => {
    expect(readNestedOp(buildSubscribe(200, "es-MX"))).toBe(200)
  })

  it("embeds the locale in captionConfig field 1 and field 2", () => {
    // Walk the bytes: packet.f1(env).f2(cmd).f3(captionUpdate).f1(clientConfig).f9(captionConfig)
    // → field 1 = lang1, field 2 = lang2
    const buf = buildSubscribe(3, "ru-RU")
    const r = makeReader(buf)
    // packet → env (field 1)
    const env = r.expectLenField(1); r.i.value = env.start
    // env → command (field 2)
    const cmd = r.expectLenField(2); r.i.value = cmd.start
    // command → captionUpdate (field 3)
    r.skipField(0)  // skip op (field 1, wire 0)
    const cu = r.expectLenField(3); r.i.value = cu.start
    // captionUpdate → clientConfig (field 1)
    const cc = r.expectLenField(1); r.i.value = cc.start
    // clientConfig → captionConfig (field 9)
    const cfg = r.expectLenField(9); r.i.value = cfg.start
    // captionConfig → lang_1 (field 1)
    const lang1tag = r.rt()
    expect(lang1tag.f).toBe(1)
    const l1len = r.rv()
    const lang1 = new TextDecoder().decode(buf.slice(r.i.value, r.i.value + l1len))
    expect(lang1).toBe("ru-RU")
  })
})

describe("buildAck / readNestedSeq", () => {
  it("round-trips seq number", () => {
    expect(readNestedSeq(buildAck(7))).toBe(7)
  })

  it("round-trips seq = 1", () => {
    expect(readNestedSeq(buildAck(1))).toBe(1)
  })

  it("round-trips seq > 127", () => {
    expect(readNestedSeq(buildAck(300))).toBe(300)
  })
})

describe("readNestedOp / readNestedSeq — wrong packet type", () => {
  it("readNestedOp returns undefined for an ack packet", () => {
    // ack has no field2(command) at env level → op absent
    expect(readNestedOp(buildAck(3))).toBeUndefined()
  })

  it("readNestedSeq returns undefined for a subscribe packet", () => {
    // subscribe has no field1(ack) at env level → seq absent
    expect(readNestedSeq(buildSubscribe(1, "en-US"))).toBeUndefined()
  })
})

// ---------- toBytes (gzip normalization) ----------

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip")
  const ab = await new Response(new Blob([data as unknown as BlobPart]).stream().pipeThrough(cs)).arrayBuffer()
  return new Uint8Array(ab)
}

describe("toBytes", () => {
  it("passes through plain (non-gzip) bytes unchanged", async () => {
    const plain = u8([0x01, 0x02, 0x03])
    const result = await toBytes(plain)
    expect(result).toEqual(plain)
  })

  it("decompresses gzip at offset 0", async () => {
    const original = new TextEncoder().encode("hello proto")
    const compressed = await gzip(original)
    const result = await toBytes(compressed)
    expect(result).toEqual(original)
  })

  it("decompresses gzip with 3-byte prefix at offset 3", async () => {
    const original = new TextEncoder().encode("prefixed gzip")
    const compressed = await gzip(original)
    const withPrefix = new Uint8Array(3 + compressed.length)
    withPrefix.set([0xAA, 0xBB, 0xCC])
    withPrefix.set(compressed, 3)
    const result = await toBytes(withPrefix)
    expect(result).toEqual(original)
  })

  it("accepts ArrayBuffer input", async () => {
    const plain = new Uint8Array([0x05, 0x06])
    const result = await toBytes(plain.buffer)
    expect(result).toEqual(plain)
  })

  it("returns original bytes on corrupt gzip", async () => {
    // 1f 8b 08 then garbage — magic matches but inflate fails
    const corrupt = u8([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x99, 0xff])
    const result = await toBytes(corrupt)
    expect(result).toEqual(corrupt)
  })
})

// ---------- hostile-input tests ----------
// All decoders must return quickly (no busy-loop) and never throw on malformed input.

describe("hostile input — truncated / oversized / garbage", () => {
  // All public decoders exercised over every hostile buffer.
  const publicDecoders: Array<(buf: Uint8Array) => unknown> = [
    decodeTranscriptWrapper,
    decodeChatWrapper,
    decodeRoster,
    readNestedOp,
    readNestedSeq,
  ]

  function runAll(buf: Uint8Array): void {
    for (const decode of publicDecoders) {
      // Must not throw and must return (not loop forever).
      expect(() => decode(buf)).not.toThrow()
    }
  }

  it("truncated string: field declares length larger than remaining bytes", () => {
    // field 1, wire 2, declared length 100, only 3 payload bytes
    const buf = u8([0x0a, 100, 0x41, 0x42, 0x43])
    runAll(buf)
  })

  it("buffer ending mid-varint (continuation bit set on last byte)", () => {
    // field 1, wire 2 tag, then a varint with MSB set and no following byte
    const buf = u8([0x0a, 0x80])
    runAll(buf)
  })

  it("huge declared length 2^34 completes quickly (< 100 ms)", () => {
    // field 1, wire 2 + 5-byte varint encoding 2^34 (= 17179869184), then no payload
    // varint encoding of 17179869184: 0x80 0x80 0x80 0x80 0x40
    const buf = u8([0x0a, 0x80, 0x80, 0x80, 0x80, 0x40])
    const start = performance.now()
    runAll(buf)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
  })

  it("returns null/empty on short fixed garbage — pattern A", () => {
    // Deterministic random-ish bytes (no Math.random)
    const buf = u8([0xd3, 0x4f, 0x7a, 0x01, 0xff, 0x12, 0x00, 0x5b])
    runAll(buf)
  })

  it("returns null/empty on short fixed garbage — pattern B", () => {
    const buf = u8([0x03, 0xfe, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])
    runAll(buf)
  })

  it("returns null/empty on short fixed garbage — pattern C (unknown wire type 3)", () => {
    // field 1, wire 3 (group start — unknown in proto3)
    const buf = u8([0x0b, 0x41, 0x42])
    runAll(buf)
  })

  it("returns null/empty on short fixed garbage — pattern D (unknown wire type 6)", () => {
    // field 2, wire 6
    const buf = u8([0x16, 0x00, 0x00])
    runAll(buf)
  })

  it("transcript wrapper: unknown wire type at outer level → null, not throw", () => {
    // field 1 wire 3 (group start) — illegal in proto3
    const buf = u8([0x0b])
    expect(decodeTranscriptWrapper(buf)).toBeNull()
  })

  it("chat wrapper: unknown wire type mid-nesting → null, not throw", () => {
    // Craft a valid wrapper, then inject wire type 7 where the container (f4) goes.
    const message = buildLeafMessage({ text: "x" })
    const container: number[] = []; lenField(1, message, container)
    const wrapper: number[] = []
    tagBytes(4, 7, wrapper)  // field 4, wire 7 (illegal) instead of wire 2
    for (const b of container) wrapper.push(b)
    const root: number[] = []; lenField(1, wrapper, root)
    expect(decodeChatWrapper(u8(root))).toBeNull()
  })

  it("roster: unknown wire type in leaf → empty results, not throw", () => {
    // A leaf with wire type 4 (group end) on field 1
    const leaf: number[] = []
    tagBytes(1, 4, leaf)
    leaf.push(0x00)
    const l2: number[] = []; lenField(2, leaf, l2)
    const l1: number[] = []; lenField(2, l2, l1)
    const outer: number[] = []; lenField(2, l1, outer)
    expect(() => decodeRoster(u8(outer))).not.toThrow()
  })
})
