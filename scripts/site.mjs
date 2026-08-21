// Assemble the public documentation site published to GitHub Pages.
//
// It does not render anything itself. `build.mjs` already turns README.md,
// CHANGELOG.md and PRIVACY.md into self-contained HTML for the in-extension doc
// pages; this script takes those exact files so the website and the pages inside
// the extension can never drift apart. It only adds what a website needs and a
// chrome-extension:// page does not: a nav between the three, and absolute links
// for the Markdown files that only exist in the repository.
//
// Run after `npm run build`, via `npm run site`. Output goes to site/.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const REPO = "https://github.com/coder0techs/platica-notes"
const OUT = "site"

// The privacy policy is the one page with an outside contract: the Chrome Web
// Store listing points its policy URL here, so this file name must stay stable.
const PAGES = [
  { from: "dist/readme.html", to: "index.html", label: "Overview" },
  // The manual used to exist only as a PDF and as pages inside the extension.
  { from: "dist/help.html", to: "manual.html", label: "User manual" },
  { from: "dist/privacy.html", to: "privacy.html", label: "Privacy policy" },
  { from: "dist/changelog.html", to: "changelog.html", label: "Release notes" },
]

for (const page of PAGES) {
  if (!existsSync(page.from)) {
    console.error(`${page.from} is missing — run \`npm run build\` first.`)
    process.exit(1)
  }
}

const NAV_STYLE = `<style>
.site-nav {
  max-width: 760px; margin: 0 auto; padding: 18px 24px 0;
  display: flex; gap: 18px; flex-wrap: wrap; align-items: baseline;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
.site-nav a { color: var(--accent); text-decoration: none; }
.site-nav a:hover { text-decoration: underline; }
.site-nav [aria-current="page"] { color: var(--ink); font-weight: 600; }
.site-nav .spacer { margin-left: auto; }
</style>`

const nav = (current) => {
  const links = PAGES.map((p) =>
    p.to === current
      ? `<a href="${p.to}" aria-current="page">${p.label}</a>`
      : `<a href="${p.to}">${p.label}</a>`,
  ).join("\n  ")
  return `<nav class="site-nav">\n  ${links}\n  <a class="spacer" href="${REPO}">Source on GitHub</a>\n</nav>`
}

// A link to a .md file resolves inside the repository, not on this site. Point
// those at the source on GitHub rather than leaving them as 404s.
const absolutiseRepoLinks = (html) =>
  html.replace(/href="(?!https?:|#|mailto:)([^"]+\.md)"/g, `href="${REPO}/blob/main/$1"`)

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
// Both stylesheets: docs.css carries no colours of its own any more, it reads
// the token layer in ui.css.
copyFileSync("dist/ui.css", `${OUT}/ui.css`)
copyFileSync("dist/docs.css", `${OUT}/docs.css`)
// The manual's figures travel with it.
cpSync("dist/manual", `${OUT}/manual`, { recursive: true })
// Plain static HTML; no Jekyll processing wanted.
writeFileSync(`${OUT}/.nojekyll`, "")

for (const page of PAGES) {
  let html = readFileSync(page.from, "utf8")
  html = absolutiseRepoLinks(html)
  html = html.replace("</head>", `${NAV_STYLE}\n</head>`)
  // The built page already carries the in-extension nav (build.mjs stamps it with
  // data-doc-nav). Its links point at options.html / history.html, which do not
  // exist on the website, so it is REPLACED rather than joined by a second nav.
  const inExtensionNav = /<nav class="doc-nav" data-doc-nav[\s\S]*?<\/nav>\n/
  if (!inExtensionNav.test(html)) {
    console.error(`${page.from} has no data-doc-nav block. build.mjs and site.mjs have drifted.`)
    process.exit(1)
  }
  html = html.replace(inExtensionNav, `${nav(page.to)}\n`)
  writeFileSync(`${OUT}/${page.to}`, html)
  console.log(`  ${page.from} → ${OUT}/${page.to}`)
}

console.log(`\nSite assembled in ${OUT}/ (${PAGES.length} pages + ui.css + docs.css).`)
