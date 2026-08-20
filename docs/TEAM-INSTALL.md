# Installing an unpacked build

The extension is published: install it from the
**[Chrome Web Store](https://chromewebstore.google.com/detail/lfnfhogdkefkfjnlhhcacebleobpgecl)**.
That build is reviewed, signed and updates itself, so it is what everyone should be
running.

This page covers the one case the store does not: putting a build that is **not
released yet** (a branch, a release candidate, a fix you want tested before it ships)
onto someone's browser. Store visibility settings do not help there, because the Web
Store reviews every item the same way regardless of visibility: `private` and
`trusted testers` do **not** skip or shorten the queue ("All visibility settings have
the same policy requirements and will go through the same review process"). An
unpacked install is the only way to get pre-release code onto a teammate's browser.

## What to send

`platica-notes-<version>.zip`, the same artifact `npm run package` builds for the
store. It is git-ignored, so hand it over out-of-band (Slack, Drive) or attach it to
a GitHub release for the version tag.

## Install (Chrome or Arc)

1. Unzip it into a **permanent** folder, e.g. `~/extensions/platica-notes`. An
   unpacked extension is loaded from that folder every time the browser starts and is
   never copied into the profile — moving, renaming or deleting it (or leaving it in
   `~/Downloads` and clearing that out) breaks the extension on the next restart.
2. Open `chrome://extensions` (Arc: `arc://extensions`).
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → pick the folder from step 1.

Verify: join a Google Meet call and check that the control pills (language,
Transcript, Rec, Wipe, Private) appear at the top. Leaving the call writes the
transcript to `Downloads/meetings/platica-notes/`.

**Remove the store version first**, or the two copies run independently: both hook the
same meeting, both capture, and both write a file, giving duplicate transcripts and
double the storage. The same applies in reverse when going back to the store build.

## What differs from a store install

- **Updates are manual.** Replace the folder's contents with the new build and press
  ⟳ on the extension's card at `chrome://extensions`. Without that reload the browser
  keeps running the old code.
- **The extension ID differs per install.** Harmless here: the extension talks to no
  server and no ID allowlist exists.
- **The browser warns about developer-mode extensions** on startup. Expected.
- **Local data is per-install.** Settings and the meeting history do not carry over
  from an unpacked install to the store version, or back.
