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

Capture reads each platform's own data path, never the on-screen caption DOM: on
Meet the WebRTC data channels, on Zoom the web client's Redux actions. Four layers,
split so that everything fragile about a platform stays in a thin slice:

1. **MAIN-world capture** (`src/content/capture/<platform>/`). A `document_start`
   script per platform. Meet's wraps `RTCPeerConnection`, attaches to the data
   channels and decodes the transcript/chat/roster protobuf (`proto.ts`); Zoom's
   claims `window.Redux` with an accessor and observes store actions (`map.ts` is
   the pure action → event mapper). Each normalises its platform's wire data into
   ONE canonical event shape and dispatches it into the isolated world via
   `CustomEvent` (`capture/protocol.ts`, JSON-string payloads).
2. **Platform-neutral core** (`src/content/core/`). `session-runner.ts` runs one
   meeting end to end (start and reload-resume, UI, attendee and presence
   bookkeeping, notes, debug trail, finalize) and knows nothing about any platform.
   `feed.ts` is the pure accumulator (revision dedupe, speaker resolution,
   interruption split) driven by per-platform `CaptionRules`. `health.ts` folds the
   capture-path state into a reason the user can act on. `session-lifecycle.ts`
   holds the pure decisions any platform's session makes.
3. **Isolated adapters** (`src/content/platforms/`). `adapter.ts` is the contract:
   meeting detection, join/end, title, meeting url, the event stream, declared
   `Capabilities` and measured timings. `meet.ts` and `zoom.ts` implement it; their
   pure decision logic is extracted (`meet-lifecycle.ts`) so it can be unit-tested.
4. **Background service worker** (`src/background/`). Session store with retention,
   finalize on meeting end or tab close (crash-resumable), `.md` export via
   `chrome.downloads`, and `platforms.ts` — the runtime registration of the opt-in
   Zoom scripts, gated on the host permission the user granted.

`src/shared/` holds the domain types, storage helpers, the content-to-background
message contract, and the optional-platform permission constants.

**Adding a platform** means: a `capture/<platform>/` script that emits canonical
events, a `platforms/<platform>.ts` implementing `PlatformAdapter`, entry points in
`build.mjs`, and (if it is opt-in) matches in `background/platforms.ts`. Nothing in
`core/` should need to change; if it does, the contract is wrong.

The canonical event's two invariants are load-bearing and documented in
`capture/protocol.ts`: `text` is CUMULATIVE, and `revision` strictly increases per
`utteranceId`. Break either and the core loses text silently.

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
  - Channel labels in `capture/meet/main.ts` (`media-session`, `captions`,
    `collections`, `meet_messages`) still route; the debug log's `channel` phases
    list what Meet actually opened, and `meet-build` records the Meet build tested.
- **The Zoom contract is fragile in a different way.** `platforms/zoom.ts` keys off
  the web client's URL shape (`/wc/<id>/join`), and `capture/zoom/main.ts` depends on
  `window.Redux` existing and on the action names `SET_NEW_L_T_MESSAGE`,
  `UPDATE_MESSAGE`, `SET_MEETING_TOPIC`, `JOIN_MEETING_SUCCESS`. If the global goes
  away the capture script reports `unsupported-client` rather than recording an empty
  file — but re-verify on a live web-client call before any release that ships Zoom.
- **The session runner's ordering is not stylistic.** The seven invariants listed at
  the top of `core/session-runner.ts` each exist because a meeting was lost once. Read
  them before touching finalize, the flush wait or the teardown order.
- **The saved-file format is structured.** `src/background/format.ts` emits the
  v2 format (YAML front matter plus a turn grid). Body text is newline-collapsed
  via `inlineText`, and front-matter scalars go through `yamlScalar`, to prevent
  forged turns and YAML injection. Cover format changes in `tests/format.test.ts`.

## Testing

`vitest`. Pure logic is deliberately extracted into testable modules (`proto.ts`,
`feed.ts`, `identity.ts`, `meet-lifecycle.ts`, `session-lifecycle.ts`, `health.ts`,
`capture/zoom/map.ts`, `format.ts`), with hostile-input coverage for anything that
parses page or wire data. The background worker and the session runner are tested
against an in-memory `chrome.*` fake (`tests/helpers/chrome-mock.ts`);
`tests/session-runner.test.ts` also needs a DOM, so it opts into jsdom with a
`// @vitest-environment jsdom` docblock. `tests/capture-protocol.test.ts` drives the
shared core through a deliberately non-Meet platform profile — if it fails while the
Meet suite passes, something Meet-specific leaked into `core/`. Prefer keeping new
decision logic pure and covered over embedding it in DOM glue.

## Conventions

- TypeScript, bundled with esbuild (`build.mjs`). No runtime dependencies ship
  (`jsdom` is a dev dependency, for the runner tests only).
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Use fictional names in test fixtures (e.g. Grace Hopper, Ada), never real
  people, and no real meeting links or ticket ids.
