# Chrome Web Store — submission prep

Copy/paste-ready text for the Developer Dashboard. Fill the `<…>` placeholders.
The extension's design (100% local, zero network) makes every answer truthful.

---

## Listing basics

- **Name:** Plática Notes
- **Short description (≤132 chars):**
  `Local meeting transcripts and chat, saved to your computer. Works with Google Meet™, nothing uploaded.`
- **Category:** Productivity › Communication
- **Language:** English (add more later if you localize the listing)

## Detailed description (suggested)

```
Plática Notes saves your meeting transcripts and in-meeting chat as a Markdown
file on your own computer: no servers, no accounts, no uploads. It currently
works with Google Meet.

• Reads Google Meet's own live captions, so the on-screen caption band never
  has to be turned on and capture keeps working in background tabs.
• Speaker-attributed transcript plus in-meeting chat, interleaved chronologically.
• Inline join and leave markers, so you can see who was in the room when.
• A floating, scrollable transcript panel inside the meeting window, with notes you
  can type as the call happens.
• Recording on/off without leaving the call: pause capture, then resume where you
  left off. Whatever was captured before the pause is still saved.
• Wipe what was captured in the current meeting, in two clicks. A meeting left with
  nothing captured writes no file at all.
• Per-meeting privacy toggle: private meetings save to a separate folder you can
  keep out of cloud sync.
• Local history of your recent meetings, with re-download and delete.
• Zero network: nothing is ever uploaded anywhere.

Google Meet is a trademark of Google LLC. Plática Notes is not created by,
affiliated with, or endorsed by Google.

Note: recording a meeting may require the consent of other participants depending
on your jurisdiction. Please inform participants and obtain any consent required.
```

## Single purpose (required)

```
Plática Notes has one purpose: to locally record and export a Google Meet
meeting's transcript and chat to the user's own computer.
```

## Permission justifications (required, per item)

- **storage** — Persist the user's settings, a rolling local history of recent
  meetings, and per-meeting crash-recovery snapshots, all in the browser's local
  extension storage.
- **unlimitedStorage** — A long meeting's transcript plus its full per-caption
  revision history, multiplied across the retained recent meetings, can exceed the
  default ~10 MB local-storage quota before the files are exported; this removes
  that ceiling so a long call is never truncated mid-capture.
- **downloads** — Write the transcript (`.md`) and the optional diagnostic log
  (`.jsonl`) files the user explicitly asked to save, into their Downloads folder.
- **Host permission `https://meet.google.com/*`** — The extension only operates on
  Google Meet; it must run its content scripts there to read the meeting's live
  captions and chat. No other site is requested (no `<all_urls>`).
- **Host permission `https://chat.google.com/*`** — Google Meet renders the
  in-meeting chat inside an embedded Google Chat (`chat.google.com`) frame. To
  capture the messages the user sends themselves (which never come back over the
  meeting page), a content script must run in that frame to read the outgoing
  message text locally. It reads only the user's own outgoing chat and never makes
  a network request; the text is passed to the meeting tab in-browser.

## Privacy practices tab (data disclosures)

- **What user data is collected/used:** "Personal communications" (the meeting
  transcript and chat are processed locally to build the saved file). Optionally
  "Personally identifiable information" in the form of participant display names
  used to label the transcript. **Nothing is transmitted off the device.**
- **Not collected by the developer:** the developer receives no data of any kind.
- **Sold to third parties?** No.
- **Used or transferred for purposes unrelated to the single purpose?** No.
- **Used or transferred to determine creditworthiness / for lending?** No.
- **Privacy policy URL:** `https://docs.google.com/document/d/e/2PACX-1vRC_V6otNoK1nCt_2Up6aJ9ZfEFtaW-1scov-Tyj5FscnreqYB-shdXYw5Xo-gyAOJpzbNhWkgcFjSm/pub`
- **Limited Use:** certify compliance — all data stays on-device and is used only
  for the single purpose above.

## Required assets checklist

- [x] Icon set 16/32/48/128 (in `public/icons/`, shipped via the manifest).
- [x] **Store icon 128×128** — the dashboard requires this separately; upload
      `public/icons/icon128.png`.
- [x] **Screenshots** — five 1280×800 PNGs in `docs/store/screenshots/`.
- [x] Optional promo tiles — `docs/store/promo/` (`npm run promo-tiles`): small
      440×280 and marquee 1400×560. Both only affect eligibility for the store's
      browse/featured surfaces; publishing does not need them.

All of these must be opaque (24-bit PNG, no alpha), which both generators satisfy.

## Package tab: leave "Verified CRX uploads" off

The dashboard offers opting in to verified CRX uploads — you sign the CRX with your
own key and the store then accepts only uploads carrying that signature. It buys
nothing for a single-maintainer project that uploads the zip by hand, and it is
effectively irreversible: lose the key (or want to opt out) and the item can only be
updated through Chrome Web Store support. Keep uploading `platica-notes-<version>.zip`.

## Screenshots

`npm run screenshots` regenerates all five (after `npm run build`). The harness
(`scripts/screenshots.mjs`) loads the real `dist/` build into a real Chromium and
drives the actual capture pipeline — the fixture transcript, chat and roster events
travel over the same MAIN-world bridge Meet's data channels feed, so the panel, the
pills and the timeline are the genuine UI, and the saved-file shot is real output
from `src/background/format.ts`. Only the meeting *stage* is a local stub page (no
real meeting, no real participants' data, and no imitation of Meet's interface).

Upload in this order, with these captions:

1. `01-in-meeting-panel.png` — "The live transcript panel: speakers, chat, join and
   leave markers, and your own notes, as the call happens."
2. `02-recording-controls.png` — "Pause capture or wipe everything recorded so far,
   without leaving the call."
3. `03-saved-file.png` — "Every meeting is saved as a Markdown file on your own
   computer. No servers, no accounts."
4. `04-history.png` — "A local history of recent meetings; re-download or delete any
   of them."
5. `05-settings.png` — "Caption language, a private-by-default toggle, and the
   folders your meetings are written to."

## Hosting the privacy policy

Done. `PRIVACY.md` is published as a Google Doc ("Publish to web") at the URL in
the Privacy-practices section above; paste that into the Privacy-policy field.
To update it later, edit the doc and re-publish (the URL stays the same).

## Build & upload

`npm run package` produces `platica-notes-<version>.zip` (manifest at the zip
root). Upload that. Package from a clean, tagged commit so `version_name` isn't
`-dirty`.
