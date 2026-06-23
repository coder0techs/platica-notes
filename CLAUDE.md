# Plática Notes - contributor guide

A Chrome MV3 extension that records Google Meet transcripts and in-meeting chat
**locally** (no servers, no accounts, no network egress). This file orients new
contributors (and Claude Code) on how the code is laid out and which invariants
must not regress. User-facing docs live in `README.md`; the post-v1 idea backlog
is in `docs/ROADMAP.md`.

## Commands

```bash
npm install
npm run build      # bundle src/ to dist/ (esbuild)
npm run watch      # rebuild on change
npm test           # unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run package    # typecheck + test + build, then zip dist/ for the Web Store
```

Load `dist/` as an unpacked extension at `chrome://extensions` (Developer mode,
then "Load unpacked"). Reload it after each build.

## Architecture

Capture reads Meet's own WebRTC data channels, not the on-screen caption DOM.
Three contexts, split by responsibility:

1. **MAIN-world capture** (`src/content/meet-rtc/`). A `document_start` script
   wraps `RTCPeerConnection`, attaches to Meet's data channels, and decodes the
   transcript/chat/roster protobuf (`proto.ts`). Typed events cross into the
   isolated world via `CustomEvent` (`bridge.ts`, JSON-string payloads). `feed.ts`
   is the pure accumulator (dedupe by message version, speaker-name resolution).
2. **Isolated adapter** (`src/content/platforms/meet.ts`). Owns the meeting
   lifecycle: join/leave detection, soft-nav loop, reload-resume, the privacy
   pill, and the caption-tail flush on leave. Pure decision logic is extracted
   into `meet-lifecycle.ts` so it can be unit-tested.
3. **Background service worker** (`src/background/`). Session store with
   retention, finalize on meeting end or tab close (crash-resumable), and `.md`
   export via `chrome.downloads`.

`src/shared/` holds the domain types, storage helpers, and the
content-to-background message contract.

## Invariants (do not regress)

- **Zero network egress.** The extension never makes a network request of its
  own. This is the product's whole promise and what keeps the store review
  truthful. Do not add `fetch` / `XHR` / `sendBeacon` / `WebSocket`. Derived
  features (summaries and the like) go through clipboard prompt-handoff or a
  local LLM, never an API call.
- **XSS-safe DOM.** Every untrusted string (speaker name, chat text, meeting
  title) reaches the DOM only via `textContent`. No `innerHTML` /
  `insertAdjacentHTML` / `outerHTML` anywhere in `src/` or `public/`. Keep it so.
- **The privacy flag is honored on every output path.** Meetings marked private
  route to the private folder and are excluded from the debug log entirely.
- **The Meet DOM contract is fragile.** `meet.ts` keys off a few Meet selectors
  (the leave icon, the meeting title). Re-verify them on a live meeting before
  each release; they are the most likely thing to break silently.
- **The saved-file format is structured.** `src/background/format.ts` emits the
  v2 format (YAML front matter plus a turn grid). Body text is newline-collapsed
  via `inlineText`, and front-matter scalars go through `yamlScalar`, to prevent
  forged turns and YAML injection. Cover format changes in `tests/format.test.ts`.

## Testing

`vitest`. Pure logic is deliberately extracted into testable modules
(`proto.ts`, `feed.ts`, `identity.ts`, `meet-lifecycle.ts`, `format.ts`), with
hostile-input coverage for the byte parsers. The background worker is tested
against an in-memory `chrome.*` fake (`tests/helpers/chrome-mock.ts`). Prefer
keeping new decision logic pure and covered over embedding it in DOM glue.

## Conventions

- TypeScript, bundled with esbuild (`build.mjs`). No runtime dependencies ship.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Use fictional names in test fixtures (e.g. Grace Hopper, Ada), never real
  people, and no real meeting links or ticket ids.
