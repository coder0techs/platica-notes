// Render the optional Chrome Web Store promo tiles (440x280 and 1400x560).
//
// Both are typographic — brand colour, wordmark, one line of promise — because the
// store's own guidance is that promo images should read at a glance and not be a
// shrunken screenshot. Output is opaque PNG (no alpha), as the dashboard requires.
//
// Usage: node scripts/promo-tiles.mjs

import { chromium } from "playwright"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const OUT = join(process.cwd(), "docs/store/promo")
const BRAND = "#4f46e5"
const icon = readFileSync(join(process.cwd(), "public/icons/icon128.png")).toString("base64")

// One shared design, two crops of emphasis: the icon, the wordmark, the promise.
const tile = ({ width, height, iconSize, name, tagline, gap, pad, text, justify }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    background:
      radial-gradient(120% 140% at 12% 0%, #6c63ff 0%, ${BRAND} 45%, #3a33c4 100%);
    color: #fff; font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: ${justify}; gap: ${gap}px;
    padding: 0 ${pad}px; box-sizing: border-box;
  }
  /* The speech-bubble mark, on a white plate so it reads on the brand colour. */
  .mark { flex: 0 0 auto; width: ${iconSize}px; height: ${iconSize}px;
          border-radius: ${Math.round(iconSize * 0.24)}px; background: #fff;
          display: grid; place-items: center;
          box-shadow: 0 ${Math.round(iconSize * 0.06)}px ${Math.round(iconSize * 0.18)}px rgba(0,0,0,.22); }
  .mark img { width: ${Math.round(iconSize * 0.84)}px; height: ${Math.round(iconSize * 0.84)}px;
              border-radius: ${Math.round(iconSize * 0.19)}px; display: block; }
  h1 { margin: 0; font-size: ${name}px; font-weight: 600; letter-spacing: -0.02em; }
  p { margin: ${Math.round(tagline * 0.5)}px 0 0; font-size: ${tagline}px; line-height: 1.35;
      color: rgba(255,255,255,.88); max-width: ${width - iconSize - gap - pad * 2}px; }
</style></head>
<body>
  <div class="mark"><img src="data:image/png;base64,${icon}" alt=""></div>
  <div>
    <h1>Plática Notes</h1>
    <p>${text}</p>
  </div>
</body></html>`

const TILES = [
  [
    "small-promo-440x280.png",
    {
      width: 440, height: 280, iconSize: 84, name: 30, tagline: 14, gap: 22, pad: 28,
      justify: "flex-start",
      text: "Meeting transcripts and chat, saved to your own computer. No servers, no accounts.",
    },
  ],
  [
    "marquee-1400x560.png",
    {
      width: 1400, height: 560, iconSize: 200, name: 68, tagline: 28, gap: 52, pad: 72,
      justify: "center",
      text: "Meeting transcripts and chat, saved to your own computer.",
    },
  ],
]

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
try {
  for (const [file, spec] of TILES) {
    const page = await browser.newPage({ viewport: { width: spec.width, height: spec.height } })
    await page.setContent(tile(spec))
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(OUT, file) })
    await page.close()
    console.log(file, `${spec.width}x${spec.height}`)
  }
} finally {
  await browser.close()
}
