// Comment stripping for the invariant scanner.
//
// The scanner looks for identifiers that must not appear in shipped code —
// innerHTML, sendBeacon, and friends. It first found two "violations" that were
// comments explaining the rule itself, which is both wrong and the kind of thing
// that teaches people to phrase comments around a grep. Code inside a comment
// does not run, so ignoring comments makes the check correct, not laxer.

/**
 * Blank out comments, keeping line count and column positions intact so a match
 * still reports the right place.
 *
 * Not a JavaScript parser, and does not need to be: it understands `//` to end
 * of line and `/* *​/` across lines, and leaves string contents alone only to the
 * extent of not mistaking `https://` for a comment. A sink hidden inside a
 * string literal is still reported, which is the safe direction to err in.
 *
 * @param {string} source
 * @returns {string[]} one entry per input line, comments replaced by spaces
 */
export function stripComments(source) {
  const out = []
  let inBlock = false

  for (const line of source.split("\n")) {
    let result = ""
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        if (line.startsWith("*/", i)) {
          inBlock = false
          result += "  "
          i += 2
        } else {
          result += " "
          i += 1
        }
        continue
      }
      if (line.startsWith("/*", i)) {
        inBlock = true
        result += "  "
        i += 2
        continue
      }
      // `//` starts a comment unless it is the `//` of a scheme, as in https://.
      if (line.startsWith("//", i) && line[i - 1] !== ":") {
        result += " ".repeat(line.length - i)
        break
      }
      result += line[i]
      i += 1
    }
    out.push(result)
  }
  return out
}
