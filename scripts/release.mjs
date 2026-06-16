// Automated semver bump from Conventional Commits.
//
// Looks at the commits since the last v* tag (or all history if none yet),
// decides the bump from their types — a breaking change (`type!:` or a
// "BREAKING CHANGE" body) → major, any `feat` → minor, otherwise → patch —
// then writes package.json, commits "chore(release): vX.Y.Z" and tags it.
// Run with `npm run release`. No manual version editing.

import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim()

// Refuse to run with uncommitted tracked changes — the release commit must be
// exactly the version bump, nothing else.
if (sh("git status --porcelain --untracked-files=no") !== "") {
  console.error("Working tree has uncommitted tracked changes — commit or stash them first.")
  process.exit(1)
}

// Commit range since the last version tag; empty range = whole history.
let range = ""
try {
  range = `${sh('git describe --tags --abbrev=0 --match "v*"')}..HEAD`
} catch {
  // No tags yet — consider all commits.
}

const subjects = sh(`git log ${range} --format=%s`).split("\n").filter(Boolean)
if (subjects.length === 0) {
  console.log("No new commits since the last release — nothing to bump.")
  process.exit(0)
}
const bodies = sh(`git log ${range} --format=%B`)

const breaking = /BREAKING CHANGE/.test(bodies) || subjects.some((s) => /^[a-z]+(\(.+?\))?!:/.test(s))
const feat = subjects.some((s) => /^feat(\(.+?\))?!?:/.test(s))
const level = breaking ? "major" : feat ? "minor" : "patch"

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const [maj, min, pat] = pkg.version.split(".").map(Number)
const next =
  level === "major" ? `${maj + 1}.0.0` : level === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`

pkg.version = next
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
sh("git add package.json")
sh(`git commit -m "chore(release): v${next}"`)
sh(`git tag v${next}`)
console.log(`${pkg.name}: ${maj}.${min}.${pat} → ${next} (${level}, ${subjects.length} commits) — tagged v${next}`)
console.log("Run `npm run build` to stamp the new version into dist.")
