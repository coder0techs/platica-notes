# Privacy Policy — Plática Notes

**Effective date:** 2026-06-18

Plática Notes is a browser extension that records Google Meet meeting transcripts
and in-meeting chat **locally on your own device**. This policy explains exactly
what it does with data. The short version: the extension collects nothing for the
developer, sends nothing over the network, and stores everything on your machine.

## What the extension handles

While you are in a Google Meet call, the extension processes, on your device only:

- **Transcript text** — Google Meet's own live captions for the meeting.
- **In-meeting chat** — messages sent in the Meet chat panel.
- **Participant names and the meeting title** — to label the transcript.
- **Your settings** — caption language, the private-by-default toggle, the debug
  toggle, and the download folder names.

## Where it is stored

- A rolling history of your most recent meetings (default: the last 30) is kept in
  the browser's local extension storage (`chrome.storage`) on your computer.
- Each meeting is written as a Markdown (`.md`) file to your **Downloads** folder
  (into the subfolders you configure). Meetings you mark **private** go to a
  separate folder so you can keep them out of any cloud sync.
- Your settings sync through your browser profile's own settings storage
  (`chrome.storage.sync`), the same way other extension preferences do.

## What is NOT done

- **No data is sent anywhere.** The extension makes no network requests of its own
  — there are no servers, no analytics, no telemetry, no accounts, and no
  third-party services. Your transcripts never leave your device through this
  extension.
- **No data is sold or shared.** The developer has no access to your data and does
  not collect it.

## How transcripts are captured (technical disclosure)

To label speakers, the extension reads Google Meet's own data locally inside the
page: it attaches to Meet's caption/chat data channels and reads the responses of
a few of Meet's own internal requests (for participant names) **as they happen in
your browser**. This reading is entirely local — none of it is transmitted, logged
remotely, or shared. It is only used to build the transcript file you asked for.

## Optional diagnostic log

The extension has an optional **Debug log** setting that is **off by default**.
When you turn it on, a diagnostic `.jsonl` file (which contains the full
transcript) is written locally to a separate Downloads folder to help troubleshoot
capture problems. It is never uploaded. Meetings you mark **private are excluded**
from the debug log entirely. Keep the debug folder out of any cloud sync, and turn
the setting off when you no longer need it.

## Your control

- Everything is on your device: delete the `.md`/`.jsonl` files from Downloads, and
  use the extension's history page to delete stored meetings, at any time.
- Uninstalling the extension removes its stored data.

## A note on consent

Recording a meeting may be subject to the consent of other participants and to the
laws of your jurisdiction. You are responsible for informing participants and
obtaining any consent required where you are.

## Changes

Any change to this policy will be reflected by an updated effective date above.

## Contact

Questions about this policy: coder0techs@icloud.com.
