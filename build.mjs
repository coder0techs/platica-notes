import * as esbuild from "esbuild"
import { cpSync, mkdirSync, rmSync } from "node:fs"

const watch = process.argv.includes("--watch")

// Clean rebuild: stale files in dist/ would still be loaded by the browser.
rmSync("dist", { recursive: true, force: true })
mkdirSync("dist", { recursive: true })
cpSync("public", "dist", { recursive: true })

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    "content-meet": "src/content/platforms/meet.ts",
    popup: "src/pages/popup/popup.ts",
    history: "src/pages/history/history.ts",
  },
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  outdir: "dist",
  logLevel: "info",
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  await esbuild.build(options)
}
