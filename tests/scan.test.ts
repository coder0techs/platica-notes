import { describe, expect, it } from "vitest"
import { stripComments } from "../scripts/lib/scan-lib.mjs"

const strip = (source: string) => stripComments(source).join("\n")

describe("stripComments", () => {
  it("blanks a line comment but keeps the code before it", () => {
    const line = "const a = 1 // innerHTML"
    const stripped = strip(line)
    expect(stripped).toMatch(/^const a = 1 +$/)
    expect(stripped).not.toContain("innerHTML")
    // Columns are preserved so a reported match still points at the right place.
    expect(stripped).toHaveLength(line.length)
  })

  it("blanks a whole-line comment", () => {
    expect(strip("// el.innerHTML = x").trim()).toBe("")
  })

  it("blanks a block comment across lines", () => {
    const source = ["/*", " * innerHTML is forbidden", " */", "const ok = 1"].join("\n")
    const lines = stripComments(source)
    expect(lines[1]).not.toContain("innerHTML")
    expect(lines[3]).toBe("const ok = 1")
  })

  it("keeps code that follows a block comment on the same line", () => {
    const line = "/* note */ const a = 1"
    const stripped = strip(line)
    expect(stripped).toMatch(/^ +const a = 1$/)
    expect(stripped).toHaveLength(line.length)
  })

  it("keeps the line count and the columns, so a match still points at the right place", () => {
    const source = ["a", "// b", "c"].join("\n")
    const lines = stripComments(source)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe("a")
    expect(lines[2]).toBe("c")
    expect(lines[1]).toHaveLength("// b".length)
  })

  it("does not mistake a url's double slash for a comment", () => {
    const line = 'const u = "https://example.com/x" // trailing'
    const stripped = strip(line)
    expect(stripped).toContain('"https://example.com/x"')
    expect(stripped).not.toContain("trailing")
  })

  it("still reports a sink hidden in a string, which is the safe direction", () => {
    // Not a comment, so it survives stripping and the scanner will flag it. A
    // false positive on a string literal is cheap; a missed sink is not.
    expect(strip('const s = "innerHTML"')).toContain("innerHTML")
  })

  it("leaves ordinary code untouched", () => {
    const code = ["export function f(x) {", "  return x / 2", "}"].join("\n")
    expect(strip(code)).toBe(code)
  })

  it("handles an unterminated block comment without swallowing later files", () => {
    // Each file is stripped independently, so an unterminated comment can only
    // affect its own lines.
    const lines = stripComments("/* open\nstill inside\n")
    expect(lines[1].trim()).toBe("")
  })
})
