// Regenerate the Chrome Web Store listing screenshots (1280x800).
//
// These are shots of the REAL extension: the build in dist/ is loaded into a real
// Chromium, and the in-meeting shot runs the actual capture pipeline — fixture
// transcript/chat/roster events are dispatched over the same MAIN-world bridge
// (`platica-rtc`) that Google Meet's data channels feed in production, so the
// panel, the pills and the timeline render exactly as they do in a live call. The
// saved-file shot is the genuine output of src/background/format.ts.
//
// Only the *stage* is synthetic: meet.google.com is served from a local stub page
// so no real meeting (and no real participant's data) is ever involved. The stub
// is deliberately abstract — it does not imitate Google Meet's interface.
//
// Usage: npm run build && node scripts/screenshots.mjs

import { chromium } from "playwright"
import * as esbuild from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIST = join(process.cwd(), "dist")
const OUT = join(process.cwd(), "docs/store/screenshots")
const WIDTH = 1280
const HEIGHT = 800
const MEETING_URL = "https://meet.google.com/abc-defg-hij"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- the stage the real panel is screenshotted over -------------------------
// Carries only what meet.ts's DOM contract needs: a `.google-symbols` element
// whose text is `call_end` (join/leave detection) and a `.u6vdEc` meeting title.
// The right third is left clear so the extension's panel never covers a tile.
const STAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Weekly product sync</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    background: radial-gradient(1100px 640px at 30% 0%, #35363a 0%, #1b1c1e 72%);
    font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #e8eaed;
    display: flex; flex-direction: column;
  }
  .u6vdEc { position: absolute; top: 20px; left: 26px; font-size: 15px; font-weight: 500; }
  .stage { flex: 1 1 auto; display: grid; gap: 14px; align-content: center;
           grid-template-columns: 1fr 1fr; padding: 70px 400px 10px 26px; }
  .tile { aspect-ratio: 16 / 10; border-radius: 12px; background: #2c2d30;
          display: grid; place-items: center; position: relative; }
  .tile.wide { grid-column: span 2; aspect-ratio: 32 / 11; }
  .avatar { width: 68px; height: 68px; border-radius: 50%; display: grid;
            place-items: center; font-size: 22px; font-weight: 500; color: #202124; }
  .name { position: absolute; left: 12px; bottom: 10px; font-size: 12px; color: #bdc1c6; }
  .bar { flex: 0 0 auto; display: flex; gap: 12px; justify-content: center;
         align-items: center; padding: 14px 0 24px; margin-right: 374px; }
  .ctl { border: 0; border-radius: 999px; width: 46px; height: 46px; background: #3c4043; }
  .ctl i { display: block; width: 14px; height: 14px; margin: 0 auto;
           border-radius: 4px; background: #e8eaed; }
  .leave { width: auto; height: 46px; padding: 0 26px; border: 0; border-radius: 999px;
           background: #ea4335; color: #fff; font: 500 14px system-ui; }
  .google-symbols { font-size: 0; }
</style></head>
<body>
  <div class="u6vdEc">Weekly product sync</div>
  <div class="stage">
    <div class="tile"><div class="avatar" style="background:#8ab4f8">GH</div>
      <div class="name">Grace Hopper</div></div>
    <div class="tile"><div class="avatar" style="background:#fdd663">AL</div>
      <div class="name">Ada Lovelace</div></div>
    <div class="tile wide"><div class="avatar" style="background:#81c995">YO</div>
      <div class="name">You</div></div>
  </div>
  <div class="bar">
    <button class="ctl"><i></i></button>
    <button class="ctl"><i></i></button>
    <button class="leave"><span class="google-symbols">call_end</span>Leave</button>
  </div>
</body></html>`

// --- fixture meeting content (fictional people, no real data) ---------------
const DEVICES = [
  ["d-grace", "Grace Hopper"],
  ["d-ada", "Ada Lovelace"],
]
const LATE_JOINER = ["d-kath", "Katherine Johnson"]
const NOTE_TEXT = "Decision: ship Thursday, Ada writes the notes"

// Each entry is one utterance; the strings are the successive caption revisions
// Meet streams for it, so the feed's dedupe-by-version path is exercised too.
const SCRIPT = [
  ["d-grace", ["So the local-only", "So the local-only capture is done —", "So the local-only capture is done — nothing leaves the machine."]],
  ["d-ada", ["Good. And the file", "Good. And the file lands in Downloads as Markdown?"]],
  ["d-grace", ["Yes, one file per", "Yes, one file per meeting, with the chat interleaved."]],
  ["chat", ["Ada Lovelace", "d-ada", "Can we get the speaker names in the header too?"]],
  ["d-grace", ["They're already in", "They're already in the front matter, along with the language."]],
  ["d-ada", ["Then let's ship it", "Then let's ship it this week and write the release notes."]],
]

async function feed(page, event) {
  await page.evaluate((detail) => {
    document.dispatchEvent(new CustomEvent("platica-rtc", { detail: JSON.stringify(detail) }))
  }, event)
}

// Fill the 1280x800 frame with a page whose natural content is smaller: measure
// the real content box (the union of the body's children, since the body itself
// stretches to the viewport), then zoom the document so it fills the frame. Real
// rendering, just scaled — no compositing.
//
// `cutAt` names a selector whose last fully-visible element decides where a page
// taller than the frame is cut, so a long page (settings) never ends mid-row; the
// remainder is filled with the page's own background colour.
async function shootPage(context, url, file, { maxScale = 2.6, zoom, cutAt, prepare } = {}) {
  const page = await context.newPage()
  await page.goto(url)
  if (prepare) await prepare(page)
  await page.waitForTimeout(400)
  const box = await page.evaluate(() => {
    let right = 0
    let bottom = 0
    for (const child of document.body.children) {
      const rect = child.getBoundingClientRect()
      right = Math.max(right, rect.right)
      bottom = Math.max(bottom, rect.bottom + window.scrollY)
    }
    return { w: right + 24, h: bottom + 24 }
  })
  const scale = zoom ?? Math.min(WIDTH / box.w, HEIGHT / box.h, maxScale)
  if (Math.abs(scale - 1) > 0.02) {
    await page.evaluate((z) => (document.documentElement.style.zoom = String(z)), scale)
    await page.waitForTimeout(300)
  }

  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 0; height: 0 }" })

  const path = join(OUT, file)
  let height = HEIGHT
  if (cutAt) {
    // Drop whatever does not fit whole, so the frame never shows a sliver of the
    // next block, then clip to what is left.
    height = await page.evaluate((selector) => {
      let cut = 0
      for (const el of document.querySelectorAll(selector)) {
        if (el.getBoundingClientRect().bottom <= window.innerHeight) {
          cut = Math.max(cut, el.getBoundingClientRect().bottom)
        } else {
          el.style.display = "none"
        }
      }
      return Math.round(cut)
    }, cutAt)
  }
  await page.screenshot({ path, clip: { x: 0, y: 0, width: WIDTH, height: Math.min(height + 24, HEIGHT) } })
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.close()
  if (height + 24 < HEIGHT) padBottom(path, background)
}

// Extend a short capture to the full 1280x800 frame using the page's own
// background colour, so the fill is seamless rather than a visible bar.
function padBottom(file, cssColor) {
  const [r, g, b] = (/rgba?\(([^)]+)\)/.exec(cssColor)?.[1] ?? "32,33,36").split(",").map(Number)
  const hex = [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")
  execFileSync("sips", ["-p", String(HEIGHT), String(WIDTH), "--padColor", hex, file, "--out", file], { stdio: "ignore" })
}

function dimensions(file) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(OUT, file)]).toString()
  return `${/pixelWidth: (\d+)/.exec(out)?.[1]}x${/pixelHeight: (\d+)/.exec(out)?.[1]}`
}

// --- the saved .md, produced by the extension's own formatter ---------------
async function savedFileMarkdown() {
  // Stamp the formatter exactly as the loaded build stamps it, so the shot shows
  // the same header a real saved file carries.
  const stamp = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8")).version_name ?? ""
  const [, version = "dev", commit = "dev"] = /^(\S+) \(([^)]+)\)$/.exec(stamp) ?? []
  const bundle = join(mkdtempSync(join(tmpdir(), "platica-fmt-")), "format.mjs")
  await esbuild.build({
    entryPoints: ["src/background/format.ts"],
    bundle: true,
    format: "esm",
    outfile: bundle,
    define: { __APP_VERSION__: JSON.stringify(version), __BUILD_COMMIT__: JSON.stringify(commit) },
    logLevel: "silent",
  })
  const { formatMeetingText, meetingFileName } = await import(bundle)

  const start = new Date("2026-07-28T09:02:00")
  const at = (seconds) => new Date(start.getTime() + seconds * 1000).toISOString()
  const speech = [
    ["Grace Hopper", 12, "So the local-only capture is done — nothing leaves the machine."],
    ["Ada Lovelace", 21, "Good. And the file lands in Downloads as Markdown?"],
    ["Grace Hopper", 29, "Yes, one file per meeting, with the chat interleaved."],
    ["Grace Hopper", 96, "They're already in the front matter, along with the language."],
    ["Ada Lovelace", 141, "Then let's ship it this week and write the release notes."],
  ]
  const meeting = {
    id: "demo",
    platform: "meet",
    title: "Weekly product sync",
    startedAt: at(0),
    endedAt: at(2640),
    isPrivate: false,
    participants: ["Grace Hopper", "Ada Lovelace", "Katherine Johnson"],
    recorder: "Grace Hopper",
    language: "en-US",
    meetingUrl: MEETING_URL,
    transcript: speech.map(([speaker, offset, text]) => ({ speaker, startedAt: at(offset), text })),
    chat: [{ sender: "Ada Lovelace", sentAt: at(62), text: "Can we get the speaker names in the header too?" }],
    notes: [{ at: at(158), text: NOTE_TEXT }],
    participantEvents: [
      { at: at(184), name: "Katherine Johnson", kind: "join" },
      { at: at(1920), name: "Katherine Johnson", kind: "leave" },
    ],
  }
  return { name: meetingFileName(meeting), text: formatMeetingText(meeting) }
}

const FILE_VIEW = (name, text) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: radial-gradient(900px 600px at 25% 0%, #303134 0%, #1b1c1e 70%);
         display: grid; place-items: center; font: 14px system-ui; color: #e8eaed; }
  .card { width: 820px; max-height: 720px; border-radius: 12px; overflow: hidden;
          background: #202124; box-shadow: 0 12px 40px rgba(0,0,0,.5);
          border: 1px solid #3c4043; display: flex; flex-direction: column; }
  .bar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
         padding: 12px 16px; background: #28292c; border-bottom: 1px solid #3c4043; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #5f6368; }
  .path { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #9aa0a6; }
  pre { margin: 0; padding: 16px 20px; overflow: hidden; white-space: pre-wrap;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e8eaed;
        /* the file is longer than the frame — fade the cut instead of slicing a line */
        mask-image: linear-gradient(#000 90%, transparent); }
</style></head>
<body>
  <div class="card">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="path" id="path"></span></div>
    <pre id="body"></pre>
  </div>
  <script>
    document.getElementById("path").textContent = ${JSON.stringify("~/Downloads/Meet Transcripts/" + name)}
    document.getElementById("body").textContent = ${JSON.stringify(text)}
  </script>
</body></html>`

const profile = mkdtempSync(join(tmpdir(), "platica-shots-"))
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const saved = await savedFileMarkdown()

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  colorScheme: "dark",
  viewport: { width: WIDTH, height: HEIGHT },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
})

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  const extensionId = new URL(worker.url()).host
  console.log("extension id:", extensionId)

  await context.route("https://meet.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: STAGE }),
  )
  await context.route("https://platica.invalid/saved-file", (route) =>
    route.fulfill({ contentType: "text/html", body: FILE_VIEW(saved.name, saved.text) }),
  )

  // --- 1. in-meeting: live panel + control pills over the stage -------------
  const page = await context.newPage()
  await page.goto(MEETING_URL)

  // The pill group appears once the adapter has detected the call. The transcript
  // row lives behind the overflow menu, so open that first; activating a row
  // closes the menu on its own, so there is nothing to close afterwards.
  const moreButton = page.locator('[data-pn="more"]')
  await moreButton.waitFor({ timeout: 15000 })
  await moreButton.click()
  await page.locator('[data-pn="transcript"]').click()

  for (const [deviceId, deviceName] of DEVICES) {
    await feed(page, { type: "device", deviceId, deviceName })
  }

  let messageId = 1
  for (const entry of SCRIPT) {
    if (entry[0] === "chat") {
      const [, [sender, deviceId, text]] = entry
      await feed(page, { type: "chat", deviceId, sender, text, messageId: `spaces/demo/messages/${messageId++}` })
      await sleep(2500)
      continue
    }
    const [deviceId, revisions] = entry
    const id = messageId++
    for (const [version, text] of revisions.entries()) {
      await feed(page, { type: "transcript", deviceId, messageId: id, messageVersion: version + 1, text })
      await sleep(700)
    }
    await sleep(2500)
  }

  // A note the recorder types during the call.
  const noteInput = page.getByPlaceholder("Add a note…")
  await noteInput.fill(NOTE_TEXT)
  await noteInput.press("Enter")
  // Leave nothing focused: a lit focus ring in a listing shot reads as a form.
  await noteInput.blur()

  // Past the join-settle window a roster arrival is a genuine mid-meeting join,
  // and a state-6 leaf is a departure — both render as timeline markers.
  await sleep(11000)
  await feed(page, { type: "device", deviceId: LATE_JOINER[0], deviceName: LATE_JOINER[1] })
  await sleep(2000)
  await feed(page, { type: "device-leave", deviceId: LATE_JOINER[0], deviceName: LATE_JOINER[1] })
  await sleep(1500)
  await page.screenshot({ path: join(OUT, "01-in-meeting-panel.png") })

  // --- 2. the same call with capture paused and Wipe armed ------------------
  // Framed like shot 1 deliberately: same call, only the pills differ. (Zooming
  // the page to enlarge them re-flows the pill group and wraps its labels.)
  await page.locator('[data-pn="recording"]').click()
  await moreButton.click()
  // First click arms the two-click confirm; the shot is of the armed state.
  await page.locator('[data-pn="wipe"]').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, "02-recording-controls.png") })
  await page.close()

  // --- 3. the saved Markdown file ------------------------------------------
  await shootPage(context, "https://platica.invalid/saved-file", "03-saved-file.png", { maxScale: 1 })

  // --- 4-5. the extension's own pages --------------------------------------
  const meetings = [
    ["Support handover", "2026-07-15T08:45:00", 84, false],
    ["Roadmap planning", "2026-07-16T15:15:00", 173, false],
    ["1:1 — Ada", "2026-07-17T10:00:00", 118, true],
    ["Retro — release 1.13", "2026-07-20T16:00:00", 194, false],
    ["Design review — export format", "2026-07-21T11:00:00", 212, false],
    ["Weekly product sync", "2026-07-22T09:02:00", 156, false],
    ["Interview — platform engineer", "2026-07-23T13:30:00", 137, true],
    ["Onboarding walkthrough", "2026-07-24T09:30:00", 201, false],
    ["1:1 — Grace", "2026-07-27T14:30:00", 96, true],
    ["Weekly product sync", "2026-07-28T09:02:00", 148, false],
  ].map(([title, startedAt, count, isPrivate], index) => ({
    id: `demo-${index}`,
    platform: "meet",
    title,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(new Date(startedAt).getTime() + 45 * 60000).toISOString(),
    isPrivate,
    participants: ["Grace Hopper", "Ada Lovelace"],
    chat: [],
    transcript: Array.from({ length: count }, (_, i) => ({
      speaker: i % 2 ? "Ada Lovelace" : "Grace Hopper",
      startedAt: new Date(new Date(startedAt).getTime() + i * 12000).toISOString(),
      text: "…",
    })),
  }))

  await shootPage(context, `chrome-extension://${extensionId}/history.html`, "04-history.png", {
    maxScale: 1.5,
    prepare: async (tab) => {
      await tab.evaluate((data) => chrome.storage.local.set({ meetings: data }), meetings)
      await tab.reload()
    },
  })
  await shootPage(context, `chrome-extension://${extensionId}/options.html`, "05-settings.png", {
    zoom: 1.15,
    cutAt: "section",
  })

  for (const file of [
    "01-in-meeting-panel.png",
    "02-recording-controls.png",
    "03-saved-file.png",
    "04-history.png",
    "05-settings.png",
  ]) {
    console.log(file, dimensions(file))
  }
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
