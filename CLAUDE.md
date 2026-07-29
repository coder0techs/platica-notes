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

## Releasing a new version

1. Update `CHANGELOG.md` (a new `## X.Y.Z - YYYY-MM-DD` section, newest first)
   and, if behaviour changed, `README.md`.
2. `npm run release` reads the Conventional Commit history since the last tag,
   bumps the version in `package.json` and `public/manifest.json` in lockstep,
   commits `chore(release): vX.Y.Z`, and tags it. No manual version editing.
3. `npm run package` runs typecheck + tests + build, then writes
   `platica-notes-<version>.zip`, the Chrome Web Store upload artifact.
4. `git push --follow-tags` to publish the release commit and its tag.
5. If the in-meeting UI, the saved-file format, or a settings/history page changed,
   `npm run screenshots` regenerates the five 1280×800 listing shots in
   `docs/store/screenshots/` from the freshly built `dist/`.
6. **If `PRIVACY.md` changed, paste it into the published privacy-policy Google Doc
   and re-publish it.** The store's policy URL serves that doc, not this file, so
   editing only the repo silently leaves the public policy stale — which is exactly
   what happened between 1.13.0 (the `chat.google.com` disclosure) and 1.14.0. Check
   the live URL's effective date against `PRIVACY.md` before submitting.
7. Upload the zip in the Web Store Developer Dashboard. Listing copy, screenshot
   order and captions are in `docs/STORE-LISTING.md`; the privacy policy is
   `PRIVACY.md`.

Do not commit the zip; it is git-ignored and fully regenerable. To share a
downloadable build, attach it to a GitLab release for the tag instead.

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
  each release; they are the most likely thing to break silently. Concrete
  pre-release check (all in the `meet.ts` DOM-contract block near the top):
  - `ICON_FONT` (`.google-symbols`) + `LEAVE_ICON_TEXT` (`call_end`) — the leave
    button still carries this icon ligature; confirm leaving the call is detected.
  - `MEETING_TITLE` (`.u6vdEc`) — still resolves the human title; if it breaks,
    capture still works but the file is named from `document.title` (the code).
  - `MEETING_PATH` regex still matches a real meeting URL.
  - Channel labels in `meet-rtc/main.ts` (`media-session`, `captions`,
    `collections`, `meet_messages`) still route; the debug log's `channel` phases
    list what Meet actually opened, and `meet-build` records the Meet build tested.
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
