// Pure parsers that pull participant identity out of Meet's RPC bodies, split
// out of main.ts so they can be unit-tested without main.ts's install() side
// effects (it wraps RTCPeerConnection/fetch/XHR at import time). Every parser is
// bounded and returns null/[] rather than throwing on hostile or truncated bytes;
// callers in main.ts additionally wrap them in try/catch.
//
// Clean reimplementation against Google Meet's wire format. Not derived from any
// third-party source code; only the public protocol shape is used.

// Strip non-base64 chars defensively, then decode to bytes. Returns null on
// failure so the caller's try/catch stays simple.
export function base64ToBytes(text: string): Uint8Array | null {
  try {
    const clean = text.replace(/[^A-Za-z0-9+/=]/g, "")
    const bin = atob(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

// A length-delimited field value looks human-name-ish: has a letter, 1..80
// chars, not a URL ("http" prefix), no "/" (rejects "users/me").
export function looksLikeName(s: string): boolean {
  if (s.length < 1 || s.length > 80) return false
  if (s.startsWith("http")) return false
  if (s.includes("/")) return false
  return /\p{L}/u.test(s)
}

// Parse the UpdateMeetingDevice RPC body: a flat protobuf whose field 1 is the
// local device's resource name (spaces/<id>/devices/<n>) and field 2 its display
// name. This is the only place Meet hands us the local user's own deviceId → name
// — self is never in the collections roster — so seeding it lets self resolve to a
// real name like any participant instead of "Speaker N". Returns null on anything
// unexpected; the caller is fully try/caught.
export function extractSelfDevice(bytes: Uint8Array): { deviceId: string; deviceName: string } | null {
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let i = 0
  let deviceId: string | null = null
  let deviceName: string | null = null
  while (i < bytes.length && (deviceId === null || deviceName === null)) {
    let tag = 0
    let shift = 0
    let ok = false
    while (i < bytes.length) {
      const b = bytes[i++]
      tag |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) { ok = true; break }
      shift += 7
      if (shift > 28) return null
    }
    if (!ok) return null
    const field = tag >> 3
    const wire = tag & 0x7
    if (wire === 2) {
      let len = 0
      let s = 0
      let lok = false
      while (i < bytes.length) {
        const b = bytes[i++]
        len |= (b & 0x7f) << s
        if ((b & 0x80) === 0) { lok = true; break }
        s += 7
        if (s > 28) return null
      }
      if (!lok || i + len > bytes.length) return null
      const val = decoder.decode(bytes.subarray(i, i + len))
      i += len
      if (field === 1 && deviceId === null) deviceId = val
      else if (field === 2 && deviceName === null) deviceName = val
    } else if (wire === 0) {
      while (i < bytes.length && (bytes[i] & 0x80) !== 0) i++
      i++
    } else if (wire === 1) {
      i += 8
    } else if (wire === 5) {
      i += 4
    } else {
      return null
    }
  }
  if (deviceId && deviceName && deviceId.includes("/devices/") && looksLikeName(deviceName)) {
    return { deviceId, deviceName }
  }
  return null
}

// Recursively walk a protobuf and collect every (deviceId, deviceName) pair: a
// submessage whose field 1 is a "spaces/<id>/devices/<n>" string and field 2 is a
// name-like string. The SyncMeetingSpaceCollections RPC response carries the full
// participant roster this way, so parsing it resolves remote speakers even when
// the collections data channel never broadcasts the roster (observed live). Fully
// bounded and try/caught by the caller.
export function extractRosterPairs(bytes: Uint8Array): Array<{ deviceId: string; deviceName: string }> {
  const pairs: Array<{ deviceId: string; deviceName: string }> = []
  const decoder = new TextDecoder("utf-8", { fatal: false })
  function walk(b: Uint8Array, depth: number): void {
    if (depth > 12) return
    let i = 0
    const strings: Record<number, string> = {}
    while (i < b.length) {
      let tag = 0
      let shift = 0
      let ok = false
      while (i < b.length) {
        const x = b[i++]
        tag |= (x & 0x7f) << shift
        if ((x & 0x80) === 0) { ok = true; break }
        shift += 7
        if (shift > 35) return
      }
      if (!ok) break
      const field = tag >>> 3
      const wire = tag & 7
      if (wire === 2) {
        let len = 0
        let s = 0
        let lok = false
        while (i < b.length) {
          const x = b[i++]
          len |= (x & 0x7f) << s
          if ((x & 0x80) === 0) { lok = true; break }
          s += 7
          if (s > 35) return
        }
        if (!lok || i + len > b.length) break
        const val = b.subarray(i, i + len)
        i += len
        if (strings[field] === undefined) {
          const str = decoder.decode(val)
          if (str.length > 0 && str.length <= 200) strings[field] = str
        }
        if (len > 1) walk(val, depth + 1)
      } else if (wire === 0) {
        while (i < b.length && (b[i] & 0x80) !== 0) i++
        i++
      } else if (wire === 1) {
        i += 8
      } else if (wire === 5) {
        i += 4
      } else {
        break
      }
    }
    if (strings[1] && strings[2] && strings[1].includes("/devices/") && looksLikeName(strings[2])) {
      pairs.push({ deviceId: strings[1], deviceName: strings[2] })
    }
  }
  walk(bytes, 0)
  return pairs
}

// Protobuf-walk GetUser bytes and return the first name-like UTF-8 string,
// scanning top-level and one level of nested length-delimited fields. The field
// index for the display name is not assumed — the name-like heuristic locates it.
export function extractSelfName(bytes: Uint8Array): string | null {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  return walkForName(bytes, decoder, 0)
}

function walkForName(bytes: Uint8Array, decoder: TextDecoder, depth: number): string | null {
  let i = 0
  while (i < bytes.length) {
    // Read field tag (varint).
    let tag = 0
    let shift = 0
    let ok = false
    while (i < bytes.length) {
      const b = bytes[i++]
      tag |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) {
        ok = true
        break
      }
      shift += 7
      if (shift > 28) return null
    }
    if (!ok) return null
    const wireType = tag & 0x7
    if (wireType === 0) {
      // varint — skip
      while (i < bytes.length && (bytes[i] & 0x80) !== 0) i++
      i++
    } else if (wireType === 1) {
      i += 8 // 64-bit
    } else if (wireType === 5) {
      i += 4 // 32-bit
    } else if (wireType === 2) {
      // length-delimited
      let len = 0
      let s2 = 0
      let lok = false
      while (i < bytes.length) {
        const b = bytes[i++]
        len |= (b & 0x7f) << s2
        if ((b & 0x80) === 0) {
          lok = true
          break
        }
        s2 += 7
        if (s2 > 28) return null
      }
      if (!lok || len < 0 || i + len > bytes.length) return null
      const sub = bytes.subarray(i, i + len)
      i += len
      try {
        const str = decoder.decode(sub)
        if (looksLikeName(str)) return str
      } catch {
        // Not valid UTF-8 — try treating it as a nested message.
        if (depth < 1) {
          const nested = walkForName(sub, decoder, depth + 1)
          if (nested) return nested
        }
        continue
      }
      // Valid UTF-8 but not name-like (e.g. "users/me", avatar URL): also try
      // nesting in case a name string lives inside this sub-message.
      if (depth < 1) {
        const nested = walkForName(sub, decoder, depth + 1)
        if (nested) return nested
      }
    } else {
      // Unknown/group wire type — give up on this level.
      return null
    }
  }
  return null
}
