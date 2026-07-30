import { describe, expect, it } from "vitest"
import {
  base64ToBytes,
  extractRosterPairs,
  extractSelfDevice,
  extractSelfName,
  looksLikeName,
} from "../src/content/capture/meet/identity"

// ---------- tiny protobuf builders ----------

function varint(n: number): number[] {
  const out: number[] = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const str = (s: string): number[] => [...new TextEncoder().encode(s)]
const lenField = (field: number, bytes: number[]): number[] => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]
const u8 = (arr: number[]): Uint8Array => new Uint8Array(arr)

// A handful of hostile inputs every byte-walker must survive without throwing.
const HOSTILE: Array<[string, Uint8Array]> = [
  ["empty", u8([])],
  ["all 0xff", u8(Array(32).fill(0xff))],
  ["never-terminating varint", u8(Array(40).fill(0x80))],
  ["wire-2 length overruns buffer", u8([...varint((1 << 3) | 2), 0x7f, 0x01, 0x02])],
  ["random garbage", u8([0x12, 0x03, 0x61, 0x08, 0xff, 0x2a, 0x99, 0x00, 0x37])],
]

describe("looksLikeName", () => {
  it("accepts a plain display name", () => expect(looksLikeName("Alice Cooper")).toBe(true))
  it("rejects a resource path", () => expect(looksLikeName("users/me")).toBe(false))
  it("rejects a URL", () => expect(looksLikeName("https://x/y")).toBe(false))
  it("rejects empty and over-long", () => {
    expect(looksLikeName("")).toBe(false)
    expect(looksLikeName("a".repeat(81))).toBe(false)
  })
})

describe("base64ToBytes", () => {
  it("decodes base64 text, stripping noise", () => {
    expect([...base64ToBytes("aGk=")!]).toEqual([...str("hi")])
    expect([...base64ToBytes(" aG\nk= ")!]).toEqual([...str("hi")])
  })
})

describe("extractSelfDevice", () => {
  it("pulls deviceId + name from a flat UpdateMeetingDevice body", () => {
    const bytes = u8([...lenField(1, str("spaces/abc/devices/5")), ...lenField(2, str("Alice"))])
    expect(extractSelfDevice(bytes)).toEqual({ deviceId: "spaces/abc/devices/5", deviceName: "Alice" })
  })
  it("returns null when the device name is not name-like", () => {
    const bytes = u8([...lenField(1, str("spaces/abc/devices/5")), ...lenField(2, str("users/me"))])
    expect(extractSelfDevice(bytes)).toBeNull()
  })
  it("returns null when field 1 is not a device resource", () => {
    const bytes = u8([...lenField(1, str("spaces/abc")), ...lenField(2, str("Alice"))])
    expect(extractSelfDevice(bytes)).toBeNull()
  })
  it.each(HOSTILE)("does not throw on hostile input: %s", (_label, bytes) => {
    let result: unknown
    expect(() => { result = extractSelfDevice(bytes) }).not.toThrow()
    expect(result).toBeNull()
  })
})

describe("extractSelfName", () => {
  it("finds a name-like string at the top level, skipping resource paths", () => {
    const bytes = u8([...lenField(1, str("users/me")), ...lenField(2, str("Bob"))])
    expect(extractSelfName(bytes)).toBe("Bob")
  })
  it("descends one level into a non-name-like submessage to find the name", () => {
    // Outer field 1 is a submessage; its raw bytes contain a "/" (a resource
    // path), so it is not name-like at the top level and the walker descends.
    const inner = [...lenField(1, str("users/123")), ...lenField(2, str("Carol"))]
    const bytes = u8(lenField(1, inner))
    expect(extractSelfName(bytes)).toBe("Carol")
  })
  it("returns null when there is no name-like field", () => {
    expect(extractSelfName(u8([...lenField(1, str("users/me")), ...varint((2 << 3) | 0), ...varint(42)]))).toBeNull()
  })
  it.each(HOSTILE)("does not throw on hostile input: %s", (_label, bytes) => {
    expect(() => extractSelfName(bytes)).not.toThrow()
  })
})

describe("extractRosterPairs", () => {
  it("collects every (deviceId, name) leaf in a container", () => {
    const leaf1 = [...lenField(1, str("spaces/x/devices/1")), ...lenField(2, str("Dave"))]
    const leaf2 = [...lenField(1, str("spaces/x/devices/2")), ...lenField(2, str("Erin"))]
    const container = u8([...lenField(1, leaf1), ...lenField(1, leaf2)])
    const pairs = extractRosterPairs(container)
    expect(pairs).toContainEqual({ deviceId: "spaces/x/devices/1", deviceName: "Dave" })
    expect(pairs).toContainEqual({ deviceId: "spaces/x/devices/2", deviceName: "Erin" })
  })
  it("returns [] when nothing looks like a device leaf", () => {
    expect(extractRosterPairs(u8(lenField(1, str("nothing here"))))).toEqual([])
  })
  it.each(HOSTILE)("does not throw on hostile input: %s", (_label, bytes) => {
    let result: unknown
    expect(() => { result = extractRosterPairs(bytes) }).not.toThrow()
    expect(Array.isArray(result)).toBe(true)
  })
})
