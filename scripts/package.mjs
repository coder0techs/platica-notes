// Produce the Chrome Web Store upload artifact: a zip of the dist/ CONTENTS
// (manifest.json at the zip root, as the store requires). Run via `npm run
// package`, which gates on typecheck + tests + a fresh build first.
//
// The zip is named with the package version. .DS_Store is excluded so a stray
// Finder artifact never sneaks into the upload. A dirty working tree is allowed
// but loudly flagged — a store artifact should come from a clean, tagged commit.

import { execSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"

const sh = (cmd, opts) => execSync(cmd, { encoding: "utf8", ...opts }).trim()

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const zipName = `${pkg.name}-${pkg.version}.zip`

if (!existsSync("dist/manifest.json")) {
  console.error("dist/ is missing or has no manifest — run `npm run build` first.")
  process.exit(1)
}

try {
  if (sh("git status --porcelain --untracked-files=no") !== "") {
    console.warn("⚠  Working tree has uncommitted tracked changes — the build is stamped '-dirty'.")
    console.warn("   For a store upload, package from a clean, tagged commit instead.")
  }
} catch {
  // git unavailable — not fatal for packaging, but the build stamp will say "unknown".
}

rmSync(zipName, { force: true })
// Zip the CONTENTS of dist/ (run inside dist/) so manifest.json lands at the
// zip root. -r recurse, -X drop extra macOS attributes, exclude .DS_Store.
sh(`zip -r -X "../${zipName}" . -x '*.DS_Store'`, { cwd: "dist", stdio: "pipe" })

const kb = (statSync(zipName).size / 1024).toFixed(1)
console.log(`\nPackaged ${zipName} (${kb} KB) — upload this to the Chrome Web Store.`)
