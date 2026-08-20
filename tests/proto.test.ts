import { describe, expect, it } from "vitest"
import {
  decodeTranscriptWrapper,
  decodeCollectionsChat,
  decodeOutgoingChat,
  decodeRoster,
  decodeRosterLeave,
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
  langId?: number
  extraField?: boolean
}): number[] {
  const out: number[] = []
  if (opts.deviceId !== undefined) lenField(1, strBytes(opts.deviceId), out)
  if (opts.messageId !== undefined) { tagBytes(2, 0, out); writeVarint(opts.messageId, out) }
  if (opts.messageVersion !== undefined) { tagBytes(3, 0, out); writeVarint(opts.messageVersion, out) }
  if (opts.text !== undefined) lenField(6, strBytes(opts.text), out)
  if (opts.langId !== undefined) { tagBytes(8, 0, out); writeVarint(opts.langId, out) }
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

  it("decodes the caption-language id (field 8) when present", () => {
    const inner = buildTranscriptMessage({
      deviceId: "dev-abc",
      messageId: 42,
      messageVersion: 1,
      text: "Hola",
      langId: 7,
    })
    const result = decodeTranscriptWrapper(buildTranscriptWrapper(inner))
    expect(result!.langId).toBe(7)
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
  messageId?: string
}): number[] {
  const out: number[] = []
  // f1 = message resource name ("spaces/…/messages/…"), the stable dedup id.
  if (opts.messageId !== undefined) lenField(1, strBytes(opts.messageId), out)
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

// ---------- collections-channel chat tests ----------

// Meet moved chat off the meet_messages channel onto the collections channel,
// wrapped as a meeting-space-collections update. Live-verified nesting:
//   root.f1 → f2 → f13 → f4 (messages collection) → { f1 = metadata; repeated f2 = message }
// where each message node is the SAME shape as before (f1=resource id, f2=deviceId,
// f5.f1=text, f8.f1=sender). Devices arrive under the sibling f13 → f1 branch.
function buildCollectionsChat(
  messages: Array<{ deviceId?: string; text?: string; sender?: string; messageId?: string }>,
): Uint8Array {
  const f4: number[] = []
  const meta: number[] = []; tagBytes(1, 0, meta); writeVarint(44, meta)
  lenField(1, meta, f4)                                  // f4.f1 = metadata
  for (const m of messages) lenField(2, buildLeafMessage(m), f4)  // f4.f2 = repeated message
  const c: number[] = []; lenField(4, f4, c)             // f13.f4
  const b: number[] = []; lenField(13, c, b)             // f2.f13
  const a: number[] = []; lenField(2, b, a)              // f1.f2
  const root: number[] = []; lenField(1, a, root)        // root.f1
  return u8(root)
}

describe("decodeCollectionsChat", () => {
  it("decodes a single incoming chat message with id, device, text and sender", () => {
    const buf = buildCollectionsChat([
      { messageId: "spaces/abc/messages/m1", deviceId: "spaces/abc/devices/306", text: "hola", sender: "Grace Hopper" },
    ])
    const result = decodeCollectionsChat(buf)
    expect(result).toHaveLength(1)
    expect(result[0].messageId).toBe("spaces/abc/messages/m1")
    expect(result[0].deviceId).toBe("spaces/abc/devices/306")
    expect(result[0].text).toBe("hola")
    expect(result[0].sender).toBe("Grace Hopper")
  })

  it("decodes every message when the collection batches several (repeated f2)", () => {
    const buf = buildCollectionsChat([
      { messageId: "spaces/abc/messages/m1", deviceId: "spaces/abc/devices/1", text: "first", sender: "Grace Hopper" },
      { messageId: "spaces/abc/messages/m2", deviceId: "spaces/abc/devices/2", text: "second", sender: "Ada Lovelace" },
    ])
    const result = decodeCollectionsChat(buf)
    expect(result.map((m) => m.text)).toEqual(["first", "second"])
    expect(result.map((m) => m.sender)).toEqual(["Grace Hopper", "Ada Lovelace"])
  })

  it("returns [] when the collections update carries devices (f13.f1), not messages (f13.f4)", () => {
    // roster-shaped update: f13 → f1 (device leaf), no f4 messages collection
    const leaf: number[] = []; lenField(1, strBytes("spaces/abc/devices/9"), leaf); lenField(2, strBytes("Grace Hopper"), leaf)
    const devColl: number[] = []; lenField(2, leaf, devColl)
    const c: number[] = []; lenField(1, devColl, c)      // f13.f1 (devices), not f4
    const b: number[] = []; lenField(13, c, b)
    const a: number[] = []; lenField(2, b, a)
    const root: number[] = []; lenField(1, a, root)
    expect(decodeCollectionsChat(u8(root))).toEqual([])
  })

  it("drops a message missing deviceId or text", () => {
    const buf = buildCollectionsChat([{ messageId: "spaces/abc/messages/m1", sender: "Grace Hopper" }])
    expect(decodeCollectionsChat(buf)).toEqual([])
  })

  it("does not throw on truncated garbage", () => {
    expect(() => decodeCollectionsChat(u8([0x0a, 100, 0x12, 0x01, 0x41]))).not.toThrow()
    expect(decodeCollectionsChat(u8([0x0a, 100, 0x12, 0x01, 0x41]))).toEqual([])
  })
})

// ---------- outgoing (own) chat tests ----------

// Our OWN chat is not echoed back to us; it exists only as an outgoing send on the
// meet_messages channel. Live-verified nesting of that send:
//   root.f1 → f1 → f3 → f1 → f2 (message) → { f3 = client ts; f5 = {f1 = text}; f6 }
// No deviceId / sender / message-id — the server assigns those; we attribute the
// text to the local user.
function buildOutgoingChat(opts: { text?: string; sentAt?: number }): Uint8Array {
  const msg: number[] = []
  if (opts.sentAt !== undefined) { tagBytes(3, 0, msg); writeVarint(opts.sentAt, msg) }
  if (opts.text !== undefined) {
    const textSub: number[] = []; lenField(1, strBytes(opts.text), textSub)
    lenField(5, textSub, msg)
  }
  tagBytes(6, 0, msg); writeVarint(1, msg)
  const l4: number[] = []; lenField(2, msg, l4)   // f2 = message
  const l3: number[] = []; lenField(1, l4, l3)    // f1
  const l2: number[] = []; tagBytes(1, 0, l2); writeVarint(1, l2); lenField(3, l3, l2)  // f1 varint + f3
  const l1: number[] = []; lenField(1, l2, l1)    // f1
  const root: number[] = []; lenField(1, l1, root)
  return u8(root)
}

describe("decodeOutgoingChat", () => {
  it("extracts the text and client timestamp from an outgoing send", () => {
    const buf = buildOutgoingChat({ text: "чат сообщение от меня", sentAt: 1783415260661 })
    const r = decodeOutgoingChat(buf)
    expect(r).not.toBeNull()
    expect(r!.text).toBe("чат сообщение от меня")
    expect(r!.sentAt).toBe(1783415260661)
  })

  it("returns the text even when no timestamp is present", () => {
    const buf = buildOutgoingChat({ text: "hi" })
    expect(decodeOutgoingChat(buf)!.text).toBe("hi")
  })

  it("returns null when the packet carries no message text", () => {
    const buf = buildOutgoingChat({ sentAt: 1 })
    expect(decodeOutgoingChat(buf)).toBeNull()
  })

  it("returns null / does not throw on unrelated or garbage bytes", () => {
    expect(decodeOutgoingChat(u8([0x08, 0x01]))).toBeNull()
    expect(() => decodeOutgoingChat(u8([0x0a, 100, 0x12, 0x01, 0x41]))).not.toThrow()
  })
})

// ---------- roster builder helpers ----------

function buildLeaf(opts: {
  deviceId?: string
  deviceName?: string
  extra?: boolean
  state?: number
  displayName?: string
  parentDeviceId?: string
}): number[] {
  const out: number[] = []
  if (opts.deviceId !== undefined) lenField(1, strBytes(opts.deviceId), out)
  if (opts.deviceName !== undefined) lenField(2, strBytes(opts.deviceName), out)
  if (opts.state !== undefined) { tagBytes(4, 0, out); writeVarint(opts.state, out) }  // presence state
  if (opts.extra) { tagBytes(5, 0, out); writeVarint(3, out) }  // unknown field
  if (opts.parentDeviceId !== undefined) lenField(21, strBytes(opts.parentDeviceId), out)
  if (opts.displayName !== undefined) lenField(29, strBytes(opts.displayName), out)
  return out
}

// Wraps leaves in the collection form without going through buildCollectionForm,
// for the cases that need a hand-built leaf.
function collectionOf(leaves: number[][]): Uint8Array {
  const l2: number[] = []
  for (const leaf of leaves) lenField(2, leaf, l2)
  const l1: number[] = []; lenField(2, l2, l1)
  const outer: number[] = []; lenField(2, l1, outer)
  return u8(outer)
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

// Single-device form, but with the leaf repeated at a chosen level of the nesting.
// `at` names the level that repeats: the outer field 1, the f13→f1 device node, or
// the leaf itself.
function buildSingleFormRepeated(
  devices: Array<{ deviceId: string; deviceName: string }>,
  at: "outer" | "node" | "leaf",
): Uint8Array {
  const leafOf = (d: { deviceId: string; deviceName: string }): number[] => buildLeaf(d)
  if (at === "leaf") {
    const s4: number[] = []
    for (const d of devices) lenField(2, leafOf(d), s4)
    const s3: number[] = []; lenField(1, s4, s3)
    const s2: number[] = []; lenField(13, s3, s2)
    const s1: number[] = []; lenField(2, s2, s1)
    const outer: number[] = []; lenField(1, s1, outer)
    return u8(outer)
  }
  if (at === "node") {
    const s3: number[] = []
    for (const d of devices) {
      const s4: number[] = []; lenField(2, leafOf(d), s4)
      lenField(1, s4, s3)
    }
    const s2: number[] = []; lenField(13, s3, s2)
    const s1: number[] = []; lenField(2, s2, s1)
    const outer: number[] = []; lenField(1, s1, outer)
    return u8(outer)
  }
  const outer: number[] = []
  for (const d of devices) {
    const s4: number[] = []; lenField(2, leafOf(d), s4)
    const s3: number[] = []; lenField(1, s4, s3)
    const s2: number[] = []; lenField(13, s3, s2)
    const s1: number[] = []; lenField(2, s2, s1)
    lenField(1, s1, outer)
  }
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

  // ar-k9i. Every level of the nesting is a protobuf field that may repeat, and
  // walking only the first occurrence silently drops the rest of the packet — the
  // participants in it are then only learned later (or never), which invents their
  // join time. Reading them all is monotonic: a single occurrence decodes exactly
  // as before.
  describe("repeated records", () => {
    const two = [
      { deviceId: "d1", deviceName: "Ada" },
      { deviceId: "d2", deviceName: "Grace" },
    ]

    it.each(["outer", "node", "leaf"] as const)(
      "reads every device of the single-device form when it repeats at the %s level",
      (at) => {
        const result = decodeRoster(buildSingleFormRepeated(two, at))
        expect(result).toEqual(two)
      },
    )

    it("reads every leaf container of the collection form, not just the first", () => {
      // Two sibling l2 containers under l1 (each holding one leaf).
      const l1: number[] = []
      for (const d of two) {
        const l2: number[] = []; lenField(2, buildLeaf(d), l2)
        lenField(2, l2, l1)
      }
      const outer: number[] = []; lenField(2, l1, outer)
      expect(decodeRoster(u8(outer))).toEqual(two)
    })

    it("reads every top-level collection container, not just the first", () => {
      const outer: number[] = []
      for (const d of two) {
        const l2: number[] = []; lenField(2, buildLeaf(d), l2)
        const l1: number[] = []; lenField(2, l2, l1)
        lenField(2, l1, outer)
      }
      expect(decodeRoster(u8(outer))).toEqual(two)
    })

    it("decodes a single record exactly as before (no behaviour change)", () => {
      expect(decodeRoster(buildSingleDeviceForm({ deviceId: "d3", deviceName: "Carol" })))
        .toEqual([{ deviceId: "d3", deviceName: "Carol" }])
      expect(decodeRoster(buildCollectionForm([{ deviceId: "d1", deviceName: "Alice" }])))
        .toEqual([{ deviceId: "d1", deviceName: "Alice" }])
    })
  })

  it("handles collection form with zero devices", () => {
    const buf = buildCollectionForm([])
    expect(decodeRoster(buf)).toEqual([])
  })

  it("extracts the presence state (leaf field 4) when present", () => {
    // A leaf carrying state 6 = the participant left (the instant-leave signal).
    const l2: number[] = []
    lenField(2, buildLeaf({ deviceId: "d1", deviceName: "Grace", state: 6 }), l2)
    lenField(2, buildLeaf({ deviceId: "d2", deviceName: "Ada", state: 1 }), l2)
    const l1: number[] = []; lenField(2, l2, l1)
    const outer: number[] = []; lenField(2, l1, outer)
    const result = decodeRoster(u8(outer))
    expect(result).toEqual([
      { deviceId: "d1", deviceName: "Grace", state: 6 },
      { deviceId: "d2", deviceName: "Ada", state: 1 },
    ])
  })

  it("omits state when the leaf has no field 4", () => {
    const result = decodeRoster(buildSingleDeviceForm({ deviceId: "d3", deviceName: "Carol" }))
    expect(result[0]).toEqual({ deviceId: "d3", deviceName: "Carol" })
    expect(result[0].state).toBeUndefined()
  })

  // ar-aml, field 29. Meet does not always send fullName (field 2) — guests and
  // dial-ins arrive with only the short displayName. Dropping the leaf for a
  // missing field 2 lost the participant AND left their speech as "Speaker N".
  it("falls back to displayName (field 29) when fullName is absent", () => {
    const result = decodeRoster(collectionOf([buildLeaf({ deviceId: "d1", displayName: "Ada" })]))
    expect(result).toEqual([{ deviceId: "d1", deviceName: "Ada" }])
  })

  it("prefers fullName over displayName when both are present", () => {
    const result = decodeRoster(collectionOf([
      buildLeaf({ deviceId: "d1", deviceName: "Ada Lovelace", displayName: "Ada" }),
    ]))
    expect(result[0].deviceName).toBe("Ada Lovelace")
  })

  it("still drops a leaf with no name at all, and one with no deviceId", () => {
    const result = decodeRoster(collectionOf([
      buildLeaf({ deviceId: "no-name" }),
      buildLeaf({ displayName: "Nameless" }), // no deviceId
      buildLeaf({ deviceId: "ok", deviceName: "Good" }),
    ]))
    expect(result).toEqual([{ deviceId: "ok", deviceName: "Good" }])
  })

  it("treats an empty fullName as absent and falls back to displayName", () => {
    const result = decodeRoster(collectionOf([
      buildLeaf({ deviceId: "d1", deviceName: "", displayName: "Ada" }),
    ]))
    expect(result[0].deviceName).toBe("Ada")
  })

  // ar-aml, field 21. A screen share arrives as its own device parented to the
  // real participant's. Reporting the parent lets the caller attribute its
  // captions to the person and keep it out of the attendee list.
  it("reports parentDeviceId (field 21) for a presentation child device", () => {
    const result = decodeRoster(collectionOf([
      buildLeaf({ deviceId: "d2", deviceName: "Ada Lovelace", parentDeviceId: "d1" }),
    ]))
    expect(result).toEqual([{ deviceId: "d2", deviceName: "Ada Lovelace", parentDeviceId: "d1" }])
  })

  it("omits parentDeviceId for an ordinary participant device", () => {
    const result = decodeRoster(collectionOf([buildLeaf({ deviceId: "d1", deviceName: "Ada" })]))
    expect(result[0].parentDeviceId).toBeUndefined()
  })

  it("decodes state 6 (left) from a real collections leave packet", () => {
    // Wire vector from a test call: a device the instant it said goodbye and
    // left (leaf field 4 = 6). This is the instant-leave signal the People panel
    // reacts to, ~1.5min before the device-removal tombstone.
    const hex =
      "0a9f02129c026a99020a96020a020839128f020a1f7370616365732f37395648774e74364f7579592f646576696365732f323434120e4b6174686c65656e20426f6f74681a6568747470733a2f2f6c68332e676f6f676c6575736572636f6e74656e742e636f6d2f612f534b703678635451734b7a71526d724e6e42736a565571364a6a42317a6a397856424b344e4667464a65614a796a73474e444d6b3063573d733139322d632d6d6f200648015802720410011802c80101ea01084b6174686c65656eb00201ba021d010203040506090a0c0d0f101112141516171b181a1c1d1e1f21222324da022c7a5a425a4d765930375830385354792d7561375878524a67397a72647137306c3857655977544e70494e713df002038004019204020801"
    const result = decodeRoster(hexToBytes(hex))
    expect(result).toHaveLength(1)
    expect(result[0].deviceId).toBe("spaces/79VHwNt6OuyY/devices/244")
    expect(result[0].deviceName).toBe("Kathleen Booth")
    expect(result[0].state).toBe(6)
  })
})

describe("decodeRosterLeave", () => {
  // Real wire vector: device 574 leaving. The removed device arrives as a bare
  // deviceId string at f1→f2→f13→f1→f3 (no name leaf), which decodeRoster drops.
  const LEAVE_574 =
    "0a2b12296a270a250a02082e1a1f7370616365732f4d7351636e785a755776474d2f646576696365732f353734"

  it("extracts the removed deviceId from a real leave packet", () => {
    expect(decodeRosterLeave(hexToBytes(LEAVE_574))).toEqual(["spaces/MsQcnxZuWvGM/devices/574"])
  })

  it("returns nothing for a normal join packet (device carries a name leaf)", () => {
    const buf = buildSingleDeviceForm({ deviceId: "d3", deviceName: "Carol" })
    expect(decodeRosterLeave(buf)).toEqual([])
  })

  it("returns nothing for an unrelated/garbage buffer and never throws", () => {
    expect(decodeRosterLeave(new Uint8Array([0x08, 0x01]))).toEqual([])
    expect(() => decodeRosterLeave(new Uint8Array([0x0a, 0xff, 0xff]))).not.toThrow()
  })

  // Same ar-k9i problem on the leave path: a teardown cascade puts several
  // departures in one packet, and only the first was read.
  it("extracts every removed deviceId when the packet carries several", () => {
    // Two device nodes under f13, each a bare f3 id.
    const s13: number[] = []
    for (const id of ["spaces/S/devices/1", "spaces/S/devices/2"]) {
      const node: number[] = []; lenField(3, strBytes(id), node)
      lenField(1, node, s13)
    }
    const s2: number[] = []; lenField(13, s13, s2)
    const s1: number[] = []; lenField(2, s2, s1)
    const outer: number[] = []; lenField(1, s1, outer)
    expect(decodeRosterLeave(u8(outer))).toEqual(["spaces/S/devices/1", "spaces/S/devices/2"])
  })

  it("extracts departures spread across repeated top-level records", () => {
    const outer: number[] = []
    for (const id of ["spaces/S/devices/1", "spaces/S/devices/2"]) {
      const node: number[] = []; lenField(3, strBytes(id), node)
      const s13: number[] = []; lenField(1, node, s13)
      const s2: number[] = []; lenField(13, s13, s2)
      const s1: number[] = []; lenField(2, s2, s1)
      lenField(1, s1, outer)
    }
    expect(decodeRosterLeave(u8(outer))).toEqual(["spaces/S/devices/1", "spaces/S/devices/2"])
  })

  it("still reads a single departure exactly as before", () => {
    expect(decodeRosterLeave(hexToBytes(LEAVE_574))).toEqual(["spaces/MsQcnxZuWvGM/devices/574"])
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
    decodeCollectionsChat,
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

  it("collections chat: unknown wire type mid-nesting → empty, not throw", () => {
    // Valid outer f1→f2→f13, then inject wire type 7 where the f4 messages
    // collection goes — the decoder must abort cleanly to [].
    const inner: number[] = []
    tagBytes(4, 7, inner)  // field 4, wire 7 (illegal) instead of wire 2
    const b13: number[] = []; lenField(13, inner, b13)
    const b2: number[] = []; lenField(2, b13, b2)
    const root: number[] = []; lenField(1, b2, root)
    expect(decodeCollectionsChat(u8(root))).toEqual([])
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
