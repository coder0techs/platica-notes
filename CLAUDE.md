# Plática Notes - contributor guide

A Chrome MV3 extension that records Google Meet transcripts and in-meeting chat
**locally** (no servers, no accounts, no network egress). This file orients new
contributors (and Claude Code) on how the code is laid out and which invariants
must not regress. The **process** around a change (branches, commits, what to run
before pushing, how a pull request is reviewed) is in `CONTRIBUTING.md`.
User-facing docs live in `README.md`; the post-v1 idea backlog is in
`docs/ROADMAP.md`.

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

Releases are automated in two steps, and neither of them edits a version number
or writes a changelog entry by hand.

1. **Write the entry when the change lands, not at release time.** Every change
   that a user could notice adds a bullet under `## Unreleased` in
   `CHANGELOG.md`, in its own pull request. CI fails a pull request that touches
   `src/` without one (label it `no-changelog` if the change really is invisible).
   The notes are user-facing prose shown in the store and on the release page, so
   they are never generated from commit subjects.
2. **`gh workflow run release.yml`.** The Release workflow derives the version
   from the Conventional Commit subjects since the last tag, dates the
   `## Unreleased` entries into a `## X.Y.Z - YYYY-MM-DD` section, bumps
   `package.json`, `public/manifest.json` and `package-lock.json` in lockstep,
   and opens a `chore(release): vX.Y.Z` pull request. Check the version and the
   notes there. `node scripts/release.mjs --dry-run` previews it locally without
   writing anything.
3. **Merge that pull request.** The Publish workflow then tags `vX.Y.Z`
   (annotated, so `--follow-tags` works), runs the checks, builds
   `platica-notes-<version>.zip` and attaches it to a GitHub release whose body is
   that changelog section. It decides whether to run by asking if `main`'s version
   already has a tag, so it is safe to re-run and does not care about merge-commit
   messages.
4. **Upload the zip** from the GitHub release in the Web Store Developer
   Dashboard. This is the only manual step left. Listing copy, screenshot order
   and captions are in `docs/STORE-LISTING.md`.
5. If the in-meeting UI, the saved-file format, or a settings/history page changed,
   `npm run screenshots` regenerates the five 1280×800 listing shots in
   `docs/store/screenshots/` from the freshly built `dist/`.
6. If a user-facing feature or setting changed, update `docs/manual/USER-MANUAL.md`
   and rebuild the PDF with `npm run manual`. It documents the **published**
   version, so write it against what the store actually serves, not the branch.
7. `PRIVACY.md` needs no publishing step of its own. The `Pages` workflow rebuilds
   <https://coder0techs.github.io/platica-notes/privacy.html> from `main` whenever
   the file changes, and the store's policy URL points there. It used to serve a
   hand-maintained Google Doc, which is exactly how the public policy went stale
   between 1.13.0 (the `chat.google.com` disclosure) and 1.14.0. All that is left
   is to bump the effective date in `PRIVACY.md` when the policy's substance
   changes.

Do not commit the zip; it is git-ignored and CI attaches one to every release. CI
also uploads a zip as a build artifact for every pull request and every push to
`main`, so a loadable build of any branch is a download away — that is what
`docs/TEAM-INSTALL.md` points at.

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

## Working with others on this repo

`CONTRIBUTING.md` is the full process. The parts worth knowing before the first
change:

- Branch off `main` as `<type>/<slug>`, matching the commit types. `main` is
  protected: no direct pushes, no force pushes, changes land through a pull
  request that the maintainer reviews and merges.
- **CI is GitHub Actions** (`.github/workflows/ci.yml`): `npm run typecheck`,
  `npm test` and `npm run build` run on every pull request and must be green
  before it can merge. What CI cannot check is the live Meet DOM contract, so
  that check stays manual and belongs in the PR description.
- Commit types are load-bearing, not decorative: `npm run release` derives the
  semver bump from the subjects since the last tag, so a feature filed as `chore`
  ships the wrong version to the store. Contributors never bump versions or
  create `v*` tags.
- The repository is public. Never commit a secret or an `.env` file: a pushed
  secret is a leaked secret, and rewriting history does not un-leak it.
- Design history lives in `docs/superpowers/specs/` (designs) and
  `docs/superpowers/plans/` (implementation plans), one dated file per feature.
  Read the design for the area before changing it; the trade-offs were already
  argued out there.
- `AGENTS.md` routes agents that do not read this file to these same rules.
- `.claude/` and `.superpowers/` are git-ignored local agent state and include
  personal session notes. Never commit them, and never move anything out of them
  into the repo without reading it first.
