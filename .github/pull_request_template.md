## What and why

<!-- What changes, and the problem it solves. Link the issue or the design doc in
docs/superpowers/specs/ if there is one. If this is a fix, say what the wrong
behaviour was, not just what the code now does. -->

## How it was verified

<!-- CI runs `npm run typecheck`, `npm test` and `npm run build` on this pull
request, so do not paste their output here: a green check is the evidence. This
section is for what CI cannot see. -->

<!-- Touched the in-meeting UI or the Meet/Zoom integration? Say what you checked
in a live meeting, and on which browser. A green suite does not prove the Meet
DOM contract still holds. If you could not check live, say so explicitly rather
than leaving it blank. -->

## Checklist

- [ ] CI is green (a red run is not reviewable)
- [ ] New decision logic is covered by a test
- [ ] The unpacked `dist/` was loaded in the browser and the change works there
- [ ] No new `fetch` / `XHR` / `sendBeacon` / `WebSocket` anywhere in `src/`
- [ ] No `innerHTML` / `insertAdjacentHTML` / `outerHTML`; untrusted strings go
      through `textContent`
- [ ] Any new output path honors the privacy flag (private folder, excluded from
      the debug log)
- [ ] Fixtures use fictional names, with no real meeting links or ticket ids
- [ ] Conventional Commit subjects, in English, correctly typed (a feature is
      `feat`, so the release bump is right)
- [ ] No version bump, no `public/manifest.json` version edit, no `v*` tag
- [ ] `CHANGELOG.md` has an entry under `## Unreleased` for anything a user could
      notice, written as user-facing prose (it becomes the release notes verbatim)
- [ ] Screenshots below, if the UI changed

## Screenshots

<!-- Before and after, if anything visual changed. Use a test meeting, not a real
one: screenshots of real calls leak participants and content. -->
