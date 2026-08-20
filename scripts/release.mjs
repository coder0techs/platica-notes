// Prepare a release commit: decide the version, date the changelog, bump every
// file that carries a version number.
//
// It deliberately does NOT tag and does NOT push. The tag is created by
// .github/workflows/publish.yml once the release commit is actually on `main`,
// so an abandoned release cannot leave a tag pointing at nothing.
//
//   node scripts/release.mjs [--dry-run]
//
// Normally you do not run this by hand at all — `gh workflow run release.yml`
// does it in CI and opens the release pull request. Run it locally with
// --dry-run to see what the next release would be.

import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { bumpLevel, cutChangelog, nextVersion, sectionFor } from "./lib/release-lib.mjs"

const dryRun = process.argv.includes("--dry-run")
const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim()

// The release commit must be exactly the version bump and the changelog cut.
if (!dryRun && sh("git status --porcelain --untracked-files=no") !== "") {
  console.error("Working tree has uncommitted tracked changes — commit or stash them first.")
  process.exit(1)
}

// Commits since the last version tag; an empty range means the whole history.
let range = ""
try {
  range = `${sh('git describe --tags --abbrev=0 --match "v*"')}..HEAD`
} catch {
  // No tags yet.
}

const subjects = sh(`git log ${range} --format=%s`).split("\n").filter(Boolean)
if (subjects.length === 0) {
  console.log("No new commits since the last release — nothing to bump.")
  process.exit(0)
}

const level = bumpLevel(subjects, sh(`git log ${range} --format=%B`))
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const current = pkg.version
const next = nextVersion(current, level)

// UTC, so the date does not depend on where the release is cut from.
const date = new Date().toISOString().slice(0, 10)

// Throws, on purpose, when there is nothing user-visible to announce or when the
// version already has a section. Better to stop here than to ship an empty entry.
const changelog = cutChangelog(readFileSync("CHANGELOG.md", "utf8"), next, date)

if (dryRun) {
  console.log(`${current} → ${next} (${level}, ${subjects.length} commits since ${range || "the beginning"})`)
  console.log(`\nRelease notes that would be published as v${next}:\n`)
  console.log(sectionFor(changelog, next))
  console.log("\n(--dry-run: nothing written)")
  process.exit(0)
}

writeFileSync("CHANGELOG.md", changelog)

pkg.version = next
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")

// The committed manifest must match the tag: build.mjs stamps the dist copy, but
// anyone reading the source or Load-unpacking public/ has to see the real version.
const manifestPath = "public/manifest.json"
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
manifest.version = next
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

// The lockfile carries the version twice. Leaving it behind is not cosmetic: it
// drifted to 1.14.0 while package.json said 1.14.1, and `npm ci` in CI is the
// thing that reads this file.
const lockPath = "package-lock.json"
const lock = JSON.parse(readFileSync(lockPath, "utf8"))
lock.version = next
if (lock.packages?.[""]) lock.packages[""].version = next
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n")

sh(`git add CHANGELOG.md package.json ${manifestPath} ${lockPath}`)
sh(`git commit -m "chore(release): v${next}"`)

console.log(`${pkg.name}: ${current} → ${next} (${level}, ${subjects.length} commits)`)
console.log(`Release commit written. The tag v${next} is created by the publish workflow once this is on main.`)
