# Instructions for AI coding agents

Any agent working in this repository (Claude Code, Cursor, Copilot, Codex,
anything else) must read both of these before editing:

- **[CLAUDE.md](CLAUDE.md)** for the architecture, the layer boundaries and the
  invariants that must not regress.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** for the process: branch names, commit
  convention, what to run before pushing, how a pull request is reviewed.

They are the authority. This file only restates the rules that are absolute, so
that an agent reading nothing else still cannot do damage.

## Hard rules

1. **Zero network egress.** Never add `fetch`, `XMLHttpRequest`, `sendBeacon` or
   `WebSocket` to `src/`. The extension makes no requests of its own, ever. This
   is the product's whole promise and what keeps the store listing truthful. If
   a feature seems to need a network call, the feature is wrong, not the rule.
2. **No HTML injection sinks.** Never use `innerHTML`, `insertAdjacentHTML` or
   `outerHTML` in `src/` or `public/`. Untrusted strings (speaker names, chat
   text, meeting titles) reach the DOM through `textContent` only.
3. **Honor the privacy flag on every output path** you add. Meetings marked
   private route to the private folder and are excluded from the debug log
   entirely.
4. **Do not bump versions or create tags.** `npm run release` owns
   `package.json` and `public/manifest.json` versions, and only the maintainer
   runs it.
5. **English only**, everywhere in the repository: code, comments, docs, commit
   messages, branch names, pull request titles and descriptions.
6. **Fictional names in fixtures.** Grace Hopper, Ada. Never real people, real
   meeting links or real ticket ids.
7. **Never commit `.claude/`, `.superpowers/`, `dist/`, `coverage/` or zips.**
   They are git-ignored, and the ignored agent state includes personal notes.

## Verification is not optional

GitHub Actions runs these three on every pull request, so a claim they pass is
checkable. Run them yourself before pushing anyway: a red CI run costs a review
cycle.

```bash
npm run typecheck
npm test
npm run build
```

Never write "fixed", "works" or "tests pass" without the run that proves it. A
unit suite does not prove the Meet DOM contract still holds, and CI cannot join
a call, so if the change touches the in-meeting UI or Meet integration, say
plainly in the pull request that a live meeting check is still needed and who
should do it.

## Scope

Do what was asked. Do not opportunistically reformat files, rename symbols,
add abstractions for a single call site, or "improve" adjacent code in the same
pull request. One PR, one concern, so a human can review it honestly.
