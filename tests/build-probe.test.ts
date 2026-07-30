import { describe, expect, it } from "vitest"
import { extractMeetBuild } from "../src/content/capture/meet/build-probe"

describe("extractMeetBuild", () => {
  it("finds the build token in a top-level value", () => {
    expect(extractMeetBuild({ cfb2h: "boq_meetingsuiserver_20260706.06_p0" })).toBe(
      "boq_meetingsuiserver_20260706.06_p0",
    )
  })

  it("finds the token nested several levels deep", () => {
    const wiz = { a: { b: [{ c: "prefix boq_meetingsuiserver_20260101.01 suffix" }] } }
    expect(extractMeetBuild(wiz)).toBe("boq_meetingsuiserver_20260101.01")
  })

  it("returns null when no build token is present", () => {
    expect(extractMeetBuild({ x: "boq_somethingelse_1", y: 42, z: null })).toBeNull()
  })

  it("returns null for non-object input", () => {
    expect(extractMeetBuild(undefined)).toBeNull()
    expect(extractMeetBuild("boq_meetingsuiserver_1")).toBeNull()
  })

  it("does not hang on a cyclic graph", () => {
    const a: Record<string, unknown> = {}
    a.self = a
    a.tag = "boq_meetingsuiserver_20260707.00"
    expect(extractMeetBuild(a)).toBe("boq_meetingsuiserver_20260707.00")
  })
})
