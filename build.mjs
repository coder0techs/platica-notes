import * as esbuild from "esbuild"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { marked } from "marked"
import { MANUAL_FIGURES } from "./scripts/lib/manual-figures.mjs"

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
// version_name accepts any string and is what Chrome shows on the extensions
// page — surface the build commit there so the loaded build is identifiable.
manifest.version_name = `${version} (${commit})`
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

// In-extension doc pages: render the repo's Markdown into static, self-contained
// HTML at build time (no runtime markdown library, no innerHTML at runtime — the
// pages are plain HTML+CSS served from chrome-extension://). The popup links to
// them. Content is the project's own docs, so rendering is trusted.
const DOC_PAGES = [
  // Help is the USER MANUAL, not README.md. README is a contributor document:
  // it opens with how to install from source and how the capture pipeline is
  // wired, and shipping it behind a "Help" link answered nobody's question.
  { md: "docs/manual/USER-MANUAL.md", out: "help.html", title: "User manual", label: "User manual" },
  // Kept for the website only: it is the project overview the Pages site lands
  // on, and it is a contributor document, so it stays out of the extension nav.
  { md: "README.md", out: "readme.html", title: "Overview", label: "Overview", siteOnly: true },
  { md: "CHANGELOG.md", out: "changelog.html", title: "Release notes", label: "What's new" },
  { md: "PRIVACY.md", out: "privacy.html", title: "Privacy policy", label: "Privacy policy" },
]

// Inside the extension these three pages are dead ends: opened from the popup,
// with no way to each other and no way back. The nav is stamped in here and
// swapped for the website's own by scripts/site.mjs (it keys off `data-doc-nav`).
const docNav = (current) => {
  const links = DOC_PAGES.filter(p => !p.siteOnly).map(p =>
    p.out === current
      ? `<a href="${p.out}" aria-current="page">${p.label}</a>`
      : `<a href="${p.out}">${p.label}</a>`,
  ).join("\n    ")
  return (
    '<nav class="doc-nav" data-doc-nav aria-label="Documentation">\n' +
    `  <div class="doc-nav-inner">\n    <a class="doc-nav-home" href="history.html">Pl\u00e1tica Notes</a>\n    ${links}\n` +
    '    <a class="doc-nav-end" href="options.html">Settings</a>\n  </div>\n</nav>'
  )
}
// The manual's figures are the store screenshots. Copy them next to the page and
// rewrite the Markdown's short names, so the in-extension manual shows the same
// pictures the PDF does instead of five broken images.
mkdirSync("dist/manual", { recursive: true })
// Every mapped figure must exist. Skipping a missing one silently was the whole
// point of the map, inverted: the manual's HTML still points at the file, so the
// help page inside the extension ships an image that does not load, and nothing
// says so. Caught for real when a build overlapped `npm run screenshots`, which
// deletes the shots before it rewrites them: dist/manual/ came out with four of
// five figures and a clean exit code. The shots are tracked, so on any real
// checkout this cannot fail; if it does, the build is the right place to stop.
for (const [figure, shot] of Object.entries(MANUAL_FIGURES)) {
  const from = `docs/store/screenshots/${shot}`
  if (!existsSync(from)) {
    console.error(
      `Manual figure ${figure} maps to ${from}, which is missing.\n` +
        `The help page links it, so the build would ship a broken image.\n` +
        `Run \`npm run screenshots\` (and let it finish) or restore the file.`,
    )
    process.exit(1)
  }
  cpSync(from, `dist/manual/${figure}`)
}

for (const doc of DOC_PAGES) {
  const body = marked
    .parse(readFileSync(doc.md, "utf8"))
    .replace(/src="([^"/:]+\.png)"/g, (match, name) =>
      Object.hasOwn(MANUAL_FIGURES, name) ? `src="manual/${name}" loading="lazy"` : match,
    )
  const page =
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${doc.title} · Plática Notes</title>\n` +
    '<link rel="stylesheet" href="ui.css">\n<link rel="stylesheet" href="docs.css">\n</head>\n' +
    `<body>\n${docNav(doc.out)}\n<main class="doc">\n${body}\n</main>\n</body>\n</html>\n`
  writeFileSync(`dist/${doc.out}`, page)
}

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    "content-meet": "src/content/platforms/meet.ts",
    "meet-rtc-main": "src/content/meet-rtc/main.ts",
    "chatgoogle-main": "src/content/chatgoogle/main.ts",
    popup: "src/pages/popup/popup.ts",
    options: "src/pages/options/options.ts",
    history: "src/pages/history/history.ts",
    welcome: "src/pages/welcome/welcome.ts",
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
