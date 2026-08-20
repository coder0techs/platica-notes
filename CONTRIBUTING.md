# Contributing to Plática Notes

This file is the **process**: how to get the extension running, what to run
before you push, and how a change reaches `main`.

What the code *is*, and which invariants a change must not regress, lives in
[CLAUDE.md](CLAUDE.md). Read that first if you are touching `src/`. It is short,
and every invariant in it is there because something broke once.

## Getting it running

```bash
npm install
npm run build   # bundles src/ into dist/
```

Then load `dist/` as an unpacked extension: open `chrome://extensions` (Arc:
`arc://extensions`), turn on Developer mode, click "Load unpacked", pick
`dist/`. Reload the extension on that page after every build. `npm run watch`
rebuilds on change, but the browser still needs the manual reload.

To see it capture for real, join a Google Meet call. The control pills appear at
the top of the meeting, and leaving the call writes the transcript to
`Downloads/meetings/platica-notes/`.

## Before you open a pull request

Run the checks locally first. GitHub Actions runs the same ones on every pull
request (`.github/workflows/ci.yml`), so a failure is going to surface either
way, and it is cheaper to see it here:

```bash
npm run check
npm run typecheck
npm test
npm run build
```

`npm run check` is the invariants: no HTML injection sinks, no new network egress,
and one version across `package.json`, `public/manifest.json` and
`package-lock.json`. It reports file and line, and it is the same script CI runs,
so there is no version of "green locally, red in CI" here.

`npm run package` chains all four and additionally zips `dist/`. Use it when your
change could affect the shipped artifact — though CI already attaches a zip to
every pull request as a build artifact, so you rarely need to.

If you touched the in-meeting UI or the Meet integration, also verify it in a
real meeting. A green suite does not prove the DOM contract still holds, and
that contract is the most likely thing to break silently. See the Meet DOM
contract invariant in CLAUDE.md for the concrete checks.

## Branches and commits

Branch off `main`, named `<type>/<short-slug>` with the same types as the commit
convention: `feat/zoom-capture`, `fix/chat-duplicate`, `docs/panel-copy`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): imperative description`. Types in use: `feat`, `fix`, `refactor`,
`docs`, `test`, `chore`, `ci`, `perf`.

This is not cosmetic. `npm run release` reads the commit subjects since the last
tag and derives the version bump from them: any `feat` makes it a minor release,
a `type!:` subject or a `BREAKING CHANGE:` footer makes it major, everything
else is a patch. A feature mislabelled as `chore` ships the wrong version number
to the Chrome Web Store.

Two rules that are easy to trip over:

- **Everything written in this repository is in English**: commit subjects and
  bodies, branch names, code, comments, docs, pull request titles and
  descriptions. That includes quoted UI strings. Reference the key or translate
  the label, never paste the original.
- **Never commit a secret or an `.env` file.** Nothing in this repository needs
  one, and this repository is public: a pushed secret is a leaked secret, and
  rewriting it out of history does not un-leak it. GitHub secret scanning is on,
  but treat it as a backstop, not a filter.

## Pull requests

- Target `main`. It is protected: no direct pushes, no force pushes, and CI must
  be green before the merge button works.
- The description template loads itself when you open the PR. Keep the checklist
  and tick only what you actually did.
- Open it as a **draft** while it is still moving. That stops a review of a
  moving target and tells everyone else which files are taken.
- The maintainer reviews and merges. Do not merge your own PR even if the button
  is enabled for you.
- The source branch is deleted automatically on merge.
- One PR, one concern. A refactor plus a feature in one diff is a diff nobody
  can review honestly.

### What a reviewer looks at

Past "does it work", in this order, all from CLAUDE.md:

- **No network egress.** No `fetch`, `XHR`, `sendBeacon` or `WebSocket`
  anywhere in `src/`. This is the product's entire promise and the basis of the
  store listing. Derived features go through clipboard handoff or a local model,
  never an API call.
- **No `innerHTML` / `insertAdjacentHTML` / `outerHTML`.** Untrusted strings
  (speaker names, chat text, meeting titles) reach the DOM through `textContent`
  only.
- **The privacy flag is honored on every new output path.** Private meetings go
  to the private folder and stay out of the debug log entirely.
- **New decision logic is pure and unit-tested** rather than embedded in DOM
  glue. Anything parsing page or wire data needs hostile-input coverage.
- **Fixtures use fictional names** (Grace Hopper, Ada), never real people, and
  no real meeting links or ticket ids.

## Releases are automated; the changelog entry is yours

Do not bump the version, do not edit the version in `public/manifest.json` or
`package-lock.json`, and do not create `v*` tags. The Release workflow owns all
of that, and CI fails a pull request that changes a version outside a
`release/*` branch.

What you do own is **the changelog entry**. Add a bullet under `## Unreleased` in
`CHANGELOG.md`, in this pull request, describing the change the way a user of the
extension would experience it. CI fails a pull request that touches `src/`
without one; if the change genuinely cannot be noticed by a user, ask for the
`no-changelog` label instead of writing a filler entry.

Write it for the audience it actually reaches. That section becomes the release
notes on the GitHub release and the text in the store, verbatim — nothing is
generated from commit subjects, precisely so the notes read like prose and not
like a commit log. Compare "**Saved meetings are filed by month.** Transcripts
now land in a `YYYY-MM` subfolder…" with what `fix(export): month subfolders`
would have produced.

## Reporting bugs and proposing features

Use the issue templates (Bug, Feature). For a bug, the version, the browser and
what the saved `.md` actually contains are worth more than a description of the
symptom.

If you attach a debug log, read the warning in the template first: the log holds
the **full transcript** of the meeting. Reproduce in a throwaway test call
rather than redacting a real one.

## Where things live

| Path | What |
|---|---|
| `CLAUDE.md` | architecture, invariants, release steps |
| `README.md` | user-facing documentation |
| `CHANGELOG.md` | per-version history, newest first |
| `PRIVACY.md` | the published privacy policy; the store's policy URL serves it |
| `scripts/site.mjs` | assembles the GitHub Pages site from the built doc pages |
| `docs/ROADMAP.md` | post-v1 backlog, ideas at varying stages of decidedness |
| `docs/superpowers/specs/` | design documents, one per feature, dated |
| `docs/superpowers/plans/` | implementation plans for those designs |
| `docs/STORE-LISTING.md` | store copy, screenshot order and captions |
| `docs/TEAM-INSTALL.md` | installing an unpacked build of unreleased code |

Before changing an area, read its design doc in `docs/superpowers/specs/`. They
record the trade-offs that were already argued out, which is usually faster than
rediscovering them.

## Not in git

`node_modules/`, `dist/`, `coverage/`, `*.zip`, the generated manual PDF, and
`.claude/` plus `.superpowers/`. The last two are local agent state, including a
session log that is personal working notes rather than project history. Do not
commit them and do not add them to a pull request.

The build artifact is regenerable, so it is never committed. To hand a build to
someone, attach the zip to a GitHub release for the tag, or send it out of band
as `docs/TEAM-INSTALL.md` describes.

## If you work with an AI agent

Point it at [AGENTS.md](AGENTS.md), which routes it to CLAUDE.md and this file.
Two expectations, because they are where agent-authored PRs usually fail review:

- The invariants above are not suggestions to be traded off against
  convenience. A PR that adds a network call to make a feature simpler gets
  closed, not discussed.
- Every claim that something works needs the evidence that shows it. CI covers
  typecheck, tests and build; anything it cannot see, such as a live-meeting
  check, needs the actual observation, not the word "works".
