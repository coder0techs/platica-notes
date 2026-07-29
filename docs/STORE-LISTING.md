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

One field per permission in the dashboard's Privacy tab; each is ≤1000 characters
and paste-ready as-is.

**storage**

```
Stores the user's own settings (caption language, private-by-default toggle, download folder names), a rolling local history of their recent meetings, and a per-meeting crash-recovery snapshot so that a tab or browser crash mid-call does not lose the transcript. All of it stays in the browser's local extension storage on the user's device; none of it is transmitted anywhere.
```

**unlimitedStorage**

```
One long meeting's transcript, plus the per-caption revision history that lets the user recover words Google's final caption dropped, can exceed the default ~10 MB local-storage quota before the file is exported - multiplied across the retained recent meetings. Without this permission a long call would be truncated mid-capture. This only lifts the local quota ceiling; no data leaves the device.
```

**downloads**

```
Writes the files the user explicitly asked for: the meeting transcript as a .md file in the user's Downloads folder and, only if the user turns on the optional debug setting, a diagnostic .jsonl log. The extension writes nothing else and never reads or modifies other downloads.
```

**Host permission** (one field covers both hosts)

```
https://meet.google.com/* - the extension only operates inside Google Meet. Its content scripts must run there to read the meeting's own live caption and chat data locally, and to render the in-meeting controls and transcript panel.

https://chat.google.com/* - Meet renders the in-meeting chat inside an embedded Google Chat frame, and a message the user sends themselves is never repeated back over the meeting page. So that the user's own chat still appears in the transcript, a content script runs in that frame and reads only the user's own outgoing message text, passing it to the meeting tab in-browser.

No other site is requested (no <all_urls>). The extension makes no network requests of its own; it only reads the responses of Meet's own in-page requests.
```

## Remote code: answer "No"

Select **"No, I am not using remote code."** Everything executable ships inside the
package: no `eval`, no `new Function`, no dynamic `import()`, no external `<script>`
or stylesheet, and `content_security_policy.extension_pages` is `script-src 'self'`.
The `fetch`/`XHR` wrappers in `meet-rtc/main.ts` only read the responses of Meet's
own in-page requests (to resolve participant names); they never fetch or execute
anything. Re-verify with a grep for `eval(`/`new Function`/`import(`/`src="http`
before each submission.

## Privacy practices tab (data disclosures)

- **Data usage — check exactly three boxes:** "Personal communications" (transcript
  and chat text), "Personally identifiable information" (participant display names,
  used to label turns), and "Website content" (the meeting title, read from the page
  and used for the file name and front matter). The store counts obtaining data as
  collection, not only transmitting it, so all three are disclosed even though
  **nothing is transmitted off the device**.
- **Deliberately NOT checked:** "Web history" — the saved meeting URL and time are
  part of the artefact the user asked to record, not a record of pages visited;
  checking it would misdescribe the extension. "User activity" — their examples are
  clicks, mouse position and keystroke logging; notes the user types into our own
  panel are not that. Authentication, financial, health and location: never touched.
  Keep this list consistent with `PRIVACY.md`, which the reviewer cross-checks.
- **Not collected by the developer:** the developer receives no data of any kind.
- **Sold to third parties?** No.
- **Used or transferred for purposes unrelated to the single purpose?** No.
- **Used or transferred to determine creditworthiness / for lending?** No.
- **Privacy policy URL:** `https://docs.google.com/document/d/e/2PACX-1vRC_V6otNoK1nCt_2Up6aJ9ZfEFtaW-1scov-Tyj5FscnreqYB-shdXYw5Xo-gyAOJpzbNhWkgcFjSm/pub`
- **Limited Use:** certify compliance — all data stays on-device and is used only
  for the single purpose above.

## Test instructions (Access tab)

Leave **Credentials** empty — there is no login to give. "Additional instructions" is
capped at **500 characters**, so this is written to fit (494) and every sentence earns
its place: the reviewer must know that Meet's on-screen caption band does not need to
be on (otherwise they conclude capture is broken) and where the file lands.

```
No account, login or backend, so there are no credentials. The extension runs only on a Google Meet meeting page.

1. Open meet.google.com and start a meeting (the account is for Meet, not for us).
2. Our controls appear at the top: language, Transcript, Rec (pause), Wipe, Private. Click Transcript for the live panel.
3. Speak, or send a chat message: attributed turns appear in the panel. Meet's caption band need not be on.
4. Leave. The .md file lands in Downloads/meetings/platica-notes/.
```

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
