// Enforce the invariants from CLAUDE.md that a machine can actually enforce.
//
// The pull-request template asks a human to tick these off. That works until
// nobody is checking, which is the whole reason this file exists. Run via
// `npm run check`; CI runs it on every pull request.
//
// What is deliberately NOT checked here: "the extension makes no network request
// of its own". It reads like a grep but is not one — the capture code *wraps*
// `window.fetch` and `XMLHttpRequest` to read Meet's own traffic, so `src/` is
// full of legitimate mentions. A blanket grep would fail every pull request, and
// narrowing it until it passed would leave a check that proves nothing. What is
// checked instead is that no NEW file starts calling them, and that the sinks
// with no legitimate use here stay at zero.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./lib/scan-lib.mjs"

const files = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    // Skip dotfiles. They are never source, and a stray .DS_Store is binary
    // rubbish that would only ever produce a confusing match.
    if (name.startsWith(".")) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(path))
    else out.push(path)
  }
  return out
}

const SRC = files("src")
const PUBLIC = files("public")
const failures = []

const scan = (paths, pattern, describe, allow = []) => {
  for (const path of paths) {
    if (allow.includes(path)) continue
    const source = readFileSync(path, "utf8")
    const raw = source.split("\n")
    // Match against comment-free lines: a comment naming a sink is documentation,
    // not a sink. Report the original line so the message is readable.
    stripComments(source).forEach((line, i) => {
      if (pattern.test(line)) failures.push(`${path}:${i + 1}: ${describe}\n    ${raw[i].trim()}`)
    })
  }
}

// XSS-safe DOM. Every untrusted string — speaker name, chat text, meeting title —
// reaches the DOM through textContent. These sinks are at zero and must stay there.
scan(
  [...SRC, ...PUBLIC],
  /\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\s*\(/,
  "HTML injection sink; untrusted strings must reach the DOM via textContent",
)

// Egress shapes with no legitimate use in this extension. Unlike fetch/XHR, these
// are never wrapped to observe the page, so any appearance is a real request.
scan(
  SRC,
  /\bsendBeacon\b|\bEventSource\b|new\s+WebSocket\b/,
  "network egress; the extension makes no requests of its own",
)

// fetch and XMLHttpRequest ARE used, but only inside the two MAIN-world hooks that
// wrap the page's own calls to read Meet's traffic. A third call site would mean
// the extension itself started talking to the network.
const HOOK_FILES = ["src/content/chatgoogle/main.ts", "src/content/meet-rtc/main.ts"]
scan(
  SRC,
  /(^|[^.\w])fetch\s*\(|\bXMLHttpRequest\b/,
  `fetch/XHR outside the MAIN-world wrappers (${HOOK_FILES.join(", ")})`,
  HOOK_FILES,
)

// One version, four places. These drifted apart before: the lockfile sat at
// 1.14.0 while package.json and the manifest said 1.14.1, and `npm ci` reads the
// lockfile.
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"))
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"))
const versions = {
  "package.json": pkg.version,
  "public/manifest.json": manifest.version,
  "package-lock.json (root)": lock.version,
  'package-lock.json (packages[""])': lock.packages?.[""]?.version,
}
const distinct = [...new Set(Object.values(versions))]
if (distinct.length !== 1) {
  failures.push(
    "version mismatch across the files that carry it:\n" +
      Object.entries(versions)
        .map(([where, v]) => `    ${where}: ${v}`)
        .join("\n"),
  )
}

if (failures.length > 0) {
  console.error(`Invariant check failed (${failures.length}):\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  process.exit(1)
}

console.log(
  `Invariants hold: ${SRC.length} files in src/, ${PUBLIC.length} in public/, version ${distinct[0]} everywhere.`,
)
