# Plática Notes

A Chrome/Chromium extension that records **Google Meet transcripts and chat
locally** — no servers, no accounts, no network calls.

## How it works

Plática Notes reads Meet's own live captions straight from the meeting's
**WebRTC data channels** (the same stream Meet uses internally), instead of
scraping the on-screen caption DOM. This means:

- **No caption band on screen** — captions never have to be turned on visually,
  so the video stays full-bleed.
- **Works in background tabs** — data channels keep flowing when a tab is
  backgrounded, so parallel meetings in different tabs are all captured.
- **Speaker names** resolve from the meeting roster; your own name comes from
  Meet's user info. Chat messages carry their sender too.

Everything is decoded in the page and kept on your machine.

## Features

- Live transcript + in-meeting chat, saved as a `.md` per meeting; consecutive
  lines from one speaker are merged into a single block for readability.
- **In-meeting transcript panel** — a floating, scrollable live transcript inside
  the Meet window, so you can scroll back and re-read without leaving the call.
  Includes a **search box** that filters the timeline, and a footer input to add
  your own **notes**.
- **Bookmarks & notes** — drop a timestamped bookmark with **Alt+Shift+B**
  (**⌥⇧B** on macOS), or type a note in the panel; both land on the timeline in
  context and are written into the saved file as tagged `(bookmark)` / `(note)`
  turns.
- **Hide all on-screen UI** — a popup toggle and **Alt+Shift+H** (**⌥⇧H** on
  macOS) hide every extension element (controls, panel, toasts) for
  screen-sharing or demos; recording keeps running while hidden.
- Full caption revision history appended at the bottom (`RAW CAPTION VERSIONS`):
  every distinct version Google streamed, so an agent can recover words the
  final caption dropped. Machine artifact, not for human reading.
- Speaker-attributed lines (others and yourself), with the closing sentence
  captured in full on leave.
- **Default caption language** (popup) — every new meeting starts in this
  language; the in-meeting language pill overrides just the current meeting and is
  not saved. Fresh installs default to English.
- **Per-meeting privacy pill** (🔒 / ☁️): private meetings download to a separate
  folder you can keep out of cloud sync.
- Local **history** of the last 30 meetings, with re-download / delete.
- Parallel meetings, mid-meeting reload (resumes), same-tab rejoin and soft-nav
  to a new meeting are all handled.
- Optional **debug log** (off by default) for diagnostics.
- **Zero network**: nothing is uploaded anywhere.

## Output

Files land in your Downloads folder:

| Folder | Contents |
|---|---|
| `Downloads/Platica Notes/` | normal meeting transcripts (`<title> <date>.md`) |
| `Downloads/Platica Notes private/` | transcripts of meetings marked private |
| `Downloads/Platica Logs/` | debug logs (`.jsonl`), only when debug is on |

### Cloud sync (optional)

Sync `Downloads/Platica Notes/` with your own tooling (e.g. Google Drive for
desktop, rsync). Keep `Platica Notes private/` **and** `Platica Logs/` out of the
synced folder — the private folder holds meetings you chose not to sync, and the
debug logs embed the full transcript. Meetings marked **private are excluded from
the debug log** entirely, so the privacy flag is honored on every output path.

## Settings

The toolbar popup keeps just the in-the-moment control, **Hide all on-screen
controls** (also Alt+Shift+H, or ⌥⇧H on macOS), which hides every extension
element for screen-sharing or demos while recording keeps running. The popup also
links to the meeting history and to the Settings page.

The **Settings page** (open it from the popup) holds everything else:

- **Default caption language.** Must match the spoken language, or the transcript
  comes out empty. It seeds every new meeting; the in-meeting pill overrides one
  call without changing the default.
- **Private by default.** New meetings start private and route to the private
  folder.
- **Folders.** The public, private, and debug-log download folders, relative to
  Downloads.
- **Debug log.** Writes a full `.jsonl` diagnostic per meeting to
  `Downloads/Platica Logs/`. Off by default. Private meetings are never logged.

## Development

```bash
npm install
npm run build      # bundle to dist/
npm run watch      # rebuild on change
npm test           # unit tests (vitest)
npm run typecheck  # tsc --noEmit
```

Load `dist/` as an unpacked extension (`chrome://extensions` →
"Load unpacked", or `arc://extensions` in Arc). Reload it after each build.

### Building for the Chrome Web Store

```bash
npm ci             # install the exact locked dependency tree
npm run package    # typecheck + test + build, then zip dist/ for upload
```

`npm run package` gates on a clean typecheck and a green test run, rebuilds
`dist/` from source, and writes `platica-notes-<version>.zip` whose root is the
contents of `dist/` (with `manifest.json` at the top level, as the store
requires). Upload that zip in the Developer Dashboard. Package from a clean,
tagged commit so the build stamp (`version_name`) is not marked `-dirty`.
Node 20+ is recommended; the build is deterministic and needs no network.

## Architecture

Three contexts, split by responsibility:

- **MAIN-world capture** (`src/content/meet-rtc/`) — a `document_start` script
  wraps `RTCPeerConnection`, attaches to Meet's data channels, decodes the
  transcript/chat/roster protobuf (`proto.ts`), and forwards typed events to the
  isolated world via `CustomEvent` (`bridge.ts`). `feed.ts` is the pure
  accumulator (dedup by message version, name resolution).
- **Isolated adapter** (`src/content/platforms/meet.ts`) — owns the meeting
  lifecycle (join/leave detection, soft-nav loop, reload-resume, privacy pill,
  caption-tail flush on leave) and pushes capture into the session.
- **Background service worker** (`src/background/`) — session store with
  retention, finalize on meeting end / tab close (with crash recovery), and
  `.md` export via `chrome.downloads`.

A small, pure shared layer (`src/shared/`) holds the domain types, storage
helpers, and the content↔background message contract.

## Scope & limitations

- Google Meet only. The adapter layer is pluggable; Zoom/Teams could follow.
- The caption language is fixed per meeting from the popup setting (changeable
  mid-meeting). It must match what's spoken.
- A very short meeting may finalize before the self-name lookup completes,
  falling back to a generic "Speaker N" label.
- Meeting end is detected from a small set of Meet DOM signals (the leave
  button); these are re-verified per release.
