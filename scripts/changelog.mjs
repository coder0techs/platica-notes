// Small CLI over the changelog helpers, for the workflows to call.
//
//   node scripts/changelog.mjs count            # entries under ## Unreleased, read from stdin
//   node scripts/changelog.mjs notes <version>  # that version's section, read from CHANGELOG.md
//
// `count` reads stdin so a workflow can pipe the base branch's file into it
// (`git show origin/main:CHANGELOG.md | node scripts/changelog.mjs count`) and
// compare against the branch's own.

import { readFileSync } from "node:fs"
import { sectionFor, unreleasedBody } from "./lib/release-lib.mjs"

const [command, argument] = process.argv.slice(2)

if (command === "count") {
  const body = unreleasedBody(readFileSync(0, "utf8"))
  const entries = body === "" ? 0 : body.split("\n").filter((line) => line.startsWith("- ")).length
  console.log(entries)
} else if (command === "notes") {
  if (!argument) {
    console.error("usage: node scripts/changelog.mjs notes <version>")
    process.exit(2)
  }
  console.log(sectionFor(readFileSync("CHANGELOG.md", "utf8"), argument))
} else {
  console.error("usage: node scripts/changelog.mjs count | notes <version>")
  process.exit(2)
}
