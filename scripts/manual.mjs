// Render docs/manual/USER-MANUAL.md to a print-ready PDF.
//
// Markdown stays the single source (readable in the repo, diffable in review); the
// print styling lives here. Screenshots are the ones generated for the store listing
// (docs/store/screenshots), inlined as data URIs so the PDF is self-contained.
//
// Usage: node scripts/manual.mjs   ->  platica-notes-manual-<version>.pdf

import { chromium } from "playwright"
import { marked } from "marked"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const SOURCE = join(ROOT, "docs/manual/USER-MANUAL.md")
const SHOTS = join(ROOT, "docs/store/screenshots")
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
const OUT = join(ROOT, `platica-notes-manual-${version}.pdf`)

// Figure names used in the Markdown -> the store screenshots they resolve to.
const FIGURES = {
  "panel.png": "01-in-meeting-panel.png",
  "recording.png": "02-recording-controls.png",
  "saved-file.png": "03-saved-file.png",
  "history.png": "04-history.png",
  "settings.png": "05-settings.png",
}

const dataUri = (file) =>
  `data:image/png;base64,${readFileSync(join(SHOTS, file)).toString("base64")}`

const CSS = `
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 10.5pt/1.55 -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #1f2024;
    -webkit-print-color-adjust: exact;
  }
  h1 {
    font-size: 30pt; line-height: 1.1; margin: 0 0 2mm; letter-spacing: -0.02em;
    color: #4f46e5;
  }
  h1 + h2 {
    font-size: 13pt; font-weight: 500; color: #5f6368; margin: 0 0 8mm;
    border: 0; padding: 0;
  }
  h2 {
    font-size: 15pt; margin: 9mm 0 3mm; padding-bottom: 1.5mm;
    border-bottom: 1px solid #e0e0e6; break-after: avoid;
  }
  h3 { font-size: 11.5pt; margin: 6mm 0 2mm; break-after: avoid; }
  p, ul, ol { margin: 0 0 3mm; }
  li { margin-bottom: 1.2mm; }
  strong { color: #14151a; }
  code {
    font: 9pt ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #f2f2f7; border-radius: 3px; padding: 0.5mm 1.2mm;
    white-space: nowrap;
  }
  hr { border: 0; border-top: 1px solid #e0e0e6; margin: 7mm 0; }
  /* Tables may split across pages (a kept-whole reference table would otherwise
     leave a third of a page empty); the header row repeats and no single row is
     ever cut in half. */
  table {
    width: 100%; border-collapse: collapse; margin: 0 0 4mm;
    font-size: 9.5pt; break-inside: auto;
  }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th {
    text-align: left; background: #f4f4f9; color: #2a2b33;
    font-weight: 600; font-size: 8.5pt; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 2mm 2.5mm; border-bottom: 1px solid #d8d8e0;
  }
  td { padding: 2mm 2.5mm; border-bottom: 1px solid #ececf2; vertical-align: top; }
  td:first-child { white-space: nowrap; }
  td:first-child code { white-space: nowrap; }
  /* Figures are kept whole (break-inside: avoid), so an oversized one leaves a
     half-empty page behind when it does not fit the remainder. Capping the width
     keeps each figure to roughly a third of the text height, which is small
     enough to flow without gaping holes and still legible at A4. */
  figure { margin: 4mm 0 5mm; break-inside: avoid; }
  figure img {
    width: 82%; display: block; border: 1px solid #dcdce4; border-radius: 4px;
  }
  /* The saved-file shot is monospace and has to stay readable, so it gets the
     full measure even though it costs more vertical space. */
  figure.wide img { width: 100%; }
  figcaption { font-size: 8.5pt; color: #6b6c76; margin-top: 1.5mm; }
`

const body = marked
  .parse(readFileSync(SOURCE, "utf8"))
  // Promote standalone images to figures with their alt text as the caption.
  .replace(
    /<p><img src="([^"]+)" alt="([^"]*)"><\/p>/g,
    (_, src, alt) =>
      `<figure${src === "saved-file.png" ? ' class="wide"' : ""}>` +
      `<img src="${dataUri(FIGURES[src] ?? src)}" alt="${alt}">` +
      `<figcaption>${alt}</figcaption></figure>`,
  )

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Plática Notes — User manual</title><style>${CSS}</style></head>
<body>${body}</body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent(html, { waitUntil: "load" })
  await page.pdf({
    path: OUT,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate:
      `<div style="width:100%;font:8pt -apple-system,system-ui,sans-serif;color:#8a8b95;` +
      `padding:0 16mm;display:flex;justify-content:space-between;">` +
      `<span>Plática Notes ${version} — user manual</span>` +
      `<span class="pageNumber"></span></div>`,
    margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
  })
  console.log(OUT)
} finally {
  await browser.close()
}
