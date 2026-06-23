# Chrome Web Store — submission prep

Copy/paste-ready text for the Developer Dashboard. Fill the `<…>` placeholders.
The extension's design (100% local, zero network) makes every answer truthful.

---

## Listing basics

- **Name:** Plática Notes
- **Short description (≤132 chars):**
  `Local meeting transcripts and chat, saved to your computer. Works with Google Meet™, nothing uploaded.`
- **Category:** Productivity
- **Language:** English (add more later if you localize the listing)

## Detailed description (suggested)

```
Plática Notes saves your meeting transcripts and in-meeting chat as a Markdown
file on your own computer: no servers, no accounts, no uploads. It currently
works with Google Meet.

• Reads Google Meet's own live captions, so the on-screen caption band never
  has to be turned on and capture keeps working in background tabs.
• Speaker-attributed transcript plus in-meeting chat, interleaved chronologically.
• A floating, scrollable transcript panel inside the meeting window.
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
- [ ] **Store icon 128×128** — the dashboard requires this separately; the packaged
      `icon128.png` can be reused.
- [ ] **At least one screenshot** 1280×800 or 640×400 (e.g. the in-meeting
      transcript panel, and the popup settings). Required to publish.
- [ ] Optional: small promo tile 440×280.

## Hosting the privacy policy

Done. `PRIVACY.md` is published as a Google Doc ("Publish to web") at the URL in
the Privacy-practices section above; paste that into the Privacy-policy field.
To update it later, edit the doc and re-publish (the URL stays the same).

## Build & upload

`npm run package` produces `platica-notes-<version>.zip` (manifest at the zip
root). Upload that. Package from a clean, tagged commit so `version_name` isn't
`-dirty`.
