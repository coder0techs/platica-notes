import { describe, expect, it, vi } from "vitest"
import { adoptPeerConnection, type AdoptablePeerConnection } from "../src/content/meet-rtc/adopt"

function fakePc() {
  const listeners: ((event: { channel: unknown }) => void)[] = []
  return {
    listeners,
    addEventListener: (type: string, listener: (event: { channel: unknown }) => void) => {
      if (type === "datachannel") listeners.push(listener)
    },
    fire: (channel: unknown) => listeners.forEach((l) => l({ channel })),
  }
}

describe("adoptPeerConnection", () => {
  it("attaches and reports that it did", () => {
    const pc = fakePc()
    expect(adoptPeerConnection(pc, new WeakSet(), () => {})).toBe(true)
    expect(pc.listeners).toHaveLength(1)
  })

  it("routes a remotely-opened channel to the handler, with its connection", () => {
    const pc = fakePc()
    const onChannel = vi.fn()
    adoptPeerConnection(pc, new WeakSet(), onChannel)
    pc.fire("media-session")
    expect(onChannel).toHaveBeenCalledWith("media-session", pc)
  })

  it("attaches once however many hooks call it", () => {
    // Every prototype hook calls this on the same connection — the constructor
    // wrapper, createDataChannel, setRemoteDescription. Two listeners would mean
    // every channel handled twice.
    const pc = fakePc()
    const seen = new WeakSet<AdoptablePeerConnection>()
    const onChannel = vi.fn()
    expect(adoptPeerConnection(pc, seen, onChannel)).toBe(true)
    expect(adoptPeerConnection(pc, seen, onChannel)).toBe(false)
    expect(adoptPeerConnection(pc, seen, onChannel)).toBe(false)
    expect(pc.listeners).toHaveLength(1)
    pc.fire("captions")
    expect(onChannel).toHaveBeenCalledTimes(1)
  })

  it("treats separate connections separately", () => {
    const seen = new WeakSet<AdoptablePeerConnection>()
    const a = fakePc()
    const b = fakePc()
    expect(adoptPeerConnection(a, seen, () => {})).toBe(true)
    expect(adoptPeerConnection(b, seen, () => {})).toBe(true)
  })

  it("never lets a handler failure escape into Meet's event dispatch", () => {
    // This listener runs inside Meet's own dispatch. Throwing there is their
    // problem, caused by us.
    const pc = fakePc()
    adoptPeerConnection(pc, new WeakSet(), () => {
      throw new Error("decoder blew up")
    })
    expect(() => pc.fire("captions")).not.toThrow()
  })
})
