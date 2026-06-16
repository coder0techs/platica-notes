import * as esbuild from "esbuild"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"

const watch = process.argv.includes("--watch")

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const version = pkg.version

// Resolve the git commit for build stamping. A build must never fail on git's
// absence, so everything is best-effort with an "unknown" fallback.
let commit = "unknown"
try {
  commit = execSync("git rev-parse --short HEAD").toString().trim()
  // Only tracked changes count as dirty — untracked .DS_Store/.claude/docs are
  // always present and must not stamp every build "-dirty".
  if (execSync("git status --porcelain --untracked-files=no").toString().trim() !== "") commit += "-dirty"
} catch {
  // No git, no repo, or git missing — leave the fallback.
}

// Clean rebuild: stale files in dist/ would still be loaded by the browser.
rmSync("dist", { recursive: true, force: true })
mkdirSync("dist", { recursive: true })
cpSync("public", "dist", { recursive: true })

// Sync the built manifest version to package.json. MV3 requires dot-separated
// integers, so strip any prerelease suffix (e.g. "0.1.0-rc1" -> "0.1.0") for
// the manifest field only. Only the dist copy is patched; public/ stays as-is.
const manifestPath = "dist/manifest.json"
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
manifest.version = version.replace(/[^0-9.].*$/, "")
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    "content-meet": "src/content/platforms/meet.ts",
    "meet-rtc-main": "src/content/meet-rtc/main.ts",
    popup: "src/pages/popup/popup.ts",
    history: "src/pages/history/history.ts",
  },
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  outdir: "dist",
  logLevel: "info",
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  await esbuild.build(options)
}
