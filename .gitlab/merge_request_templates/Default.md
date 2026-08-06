## What and why

<!-- What changes, and the problem it solves. Link the issue or the design doc in
docs/superpowers/specs/ if there is one. If this is a fix, say what the wrong
behaviour was, not just what the code now does. -->

## How it was verified

<!-- Paste the actual output. "Tests pass" without the run counts as untested.
There is no CI in this project yet, so this section is the only evidence a
reviewer gets. -->

```
$ npm run typecheck

$ npm test

$ npm run build

```

<!-- Touched the in-meeting UI or the Meet/Zoom integration? Say what you checked
in a live meeting, and on which browser. If you could not check live, say so
explicitly rather than leaving it blank. -->

## Checklist

- [ ] `npm run typecheck` clean
- [ ] `npm test` green, and new decision logic is covered by a test
- [ ] `npm run build` succeeds and the unpacked `dist/` loads in the browser
- [ ] No new `fetch` / `XHR` / `sendBeacon` / `WebSocket` anywhere in `src/`
- [ ] No `innerHTML` / `insertAdjacentHTML` / `outerHTML`; untrusted strings go
      through `textContent`
- [ ] Any new output path honors the privacy flag (private folder, excluded from
      the debug log)
- [ ] Fixtures use fictional names, with no real meeting links or ticket ids
- [ ] Conventional Commit subjects, in English, correctly typed (a feature is
      `feat`, so the release bump is right)
- [ ] No version bump, no `public/manifest.json` version edit, no `v*` tag
- [ ] User-visible change described above, so it can go into `CHANGELOG.md` at
      release time
- [ ] Screenshots below, if the UI changed

## Screenshots

<!-- Before and after, if anything visual changed. Use a test meeting, not a real
one: screenshots of real calls leak participants and content. -->

/assign_reviewer @alexander.rodriguez
