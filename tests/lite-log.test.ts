import { describe, expect, it } from "vitest"
import { toLiteEvent } from "../src/shared/lite-log"

describe("toLiteEvent: which events survive", () => {
  it("keeps a lifecycle event, the whole reason the lite log exists", () => {
    expect(toLiteEvent({ ctx: "rtc", phase: "channel", label: "captions_v2", state: "connecting", id: 6 })).toEqual({
      ctx: "rtc",
      phase: "channel",
      label: "captions_v2",
      state: "connecting",
      id: 6,
    })
  })

  it("keeps the counters that showed the fault", () => {
    const funnel = { ctx: "rtc", phase: "funnel", reason: "tick", wire: 0, decoded: 0, dispatched: 0, dropped: 0 }
    expect(toLiteEvent(funnel)).toEqual(funnel)
  })

  it("drops the caption event outright, text or no text", () => {
    expect(toLiteEvent({ ctx: "rtc", phase: "transcript", text: "Hello world", deviceId: "d/devices/74" })).toBeNull()
  })

  it("drops every chat event", () => {
    expect(toLiteEvent({ ctx: "rtc", phase: "chat", text: "see you", deviceId: "d/devices/74" })).toBeNull()
    expect(toLiteEvent({ ctx: "rtc", phase: "chat-decoded", got: { text: "see you" } })).toBeNull()
  })

  it("drops raw RPC and send dumps, which carry names and chat in hex", () => {
    for (const phase of ["rpc", "send-raw", "outbound", "roster-decoded"]) {
      expect(toLiteEvent({ ctx: "rtc", phase, hex: "0a0b" }), phase).toBeNull()
    }
  })

  it("drops a phase it has never heard of, rather than guessing it is safe", () => {
    // Default-deny. A phase added later is excluded until someone decides it
    // carries nothing; the opposite default leaks the first time it is wrong.
    expect(toLiteEvent({ ctx: "rtc", phase: "some-future-phase", note: "whatever" })).toBeNull()
  })

  it("keeps the adapter and background events that frame a meeting", () => {
    expect(toLiteEvent({ ctx: "adapter", msg: "capture armed" })).toEqual({ ctx: "adapter", msg: "capture armed" })
    expect(toLiteEvent({ ctx: "bg", msg: "finalized empty", utterances: 0, chat: 0 })).toEqual({
      ctx: "bg",
      msg: "finalized empty",
      utterances: 0,
      chat: 0,
    })
  })
})

describe("toLiteEvent: what survives inside an event it keeps", () => {
  it("passes numbers and booleans through untouched", () => {
    expect(toLiteEvent({ ctx: "rtc", phase: "capture-state", pcsAdopted: 2, prototypeHookLanded: true })).toEqual({
      ctx: "rtc",
      phase: "capture-state",
      pcsAdopted: 2,
      prototypeHookLanded: true,
    })
  })

  it("keeps the channel list, which is what named the new channel", () => {
    expect(
      toLiteEvent({ ctx: "rtc", phase: "capture-state", channels: ["captions", "captions_v2", "collections"] }),
    ).toEqual({ ctx: "rtc", phase: "capture-state", channels: ["captions", "captions_v2", "collections"] })
  })

  it("keeps a frame shape, which is already content-free by construction", () => {
    const shape = "1{1{1=v3,2=v16,3{3=s11,4=s5,5=s5,6=s29,9=v1}}}"
    expect(toLiteEvent({ ctx: "rtc", phase: "channel-raw", label: "captions_v2", bytes: 74, shape })).toEqual({
      ctx: "rtc",
      phase: "channel-raw",
      label: "captions_v2",
      bytes: 74,
      shape,
    })
  })

  it("drops raw hex even on an allowed phase", () => {
    const lite = toLiteEvent({ ctx: "rtc", phase: "channel-raw", label: "captions_v2", hex: "0a480a3e0801" })
    expect(lite).not.toBeNull()
    expect(lite).not.toHaveProperty("hex")
  })

  it("replaces an unlisted string with its length, never its value", () => {
    // Default-deny again, one level down: a string key nobody vetted is assumed
    // to be content.
    const lite = toLiteEvent({ ctx: "rtc", phase: "channel", label: "captions", speakerName: "Grace Hopper" })
    expect(lite!.speakerName).toBe("<12 chars>")
  })

  it("redacts a participant name, which is not content but is not needed either", () => {
    const lite = toLiteEvent({ ctx: "adapter", msg: "device seen", name: "Ada Lovelace", deviceId: "s/devices/12" })
    expect(lite!.name).toBe("<12 chars>")
    expect(lite!.deviceId).toBe("s/devices/12")
  })

  it("drops a nested object rather than walking into it", () => {
    const lite = toLiteEvent({ ctx: "rtc", phase: "channel", label: "captions", got: { text: "Hello world" } })
    expect(lite).not.toHaveProperty("got")
    expect(JSON.stringify(lite)).not.toContain("Hello")
  })

  it("leaves no spoken word anywhere in the output, whatever the key is called", () => {
    const lite = toLiteEvent({
      ctx: "rtc",
      phase: "capture-state",
      title: "Layoffs planning",
      note: "we should ship on Friday",
      caption: "Hello world",
    })
    const json = JSON.stringify(lite)
    for (const word of ["Layoffs", "Friday", "Hello", "ship"]) expect(json, word).not.toContain(word)
  })
})
