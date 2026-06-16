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

- Live transcript + in-meeting chat, saved as a `.md` per meeting.
- Full caption revision history appended at the bottom (`RAW CAPTION VERSIONS`):
  every distinct version Google streamed, so an agent can recover words the
  final caption dropped. Machine artifact, not for human reading.
- Speaker-attributed lines (others and yourself), with the closing sentence
  captured in full on leave.
- **Caption language** picker (popup) — set it to the language people speak;
  default is Russian.
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
debug logs embed the full transcript regardless of the privacy flag.

## Settings (popup)

- **Caption language** — must match the spoken language, or the transcript comes
  out empty.
- **Private by default** — new meetings start private (route to the private
  folder).
- **Debug log** — write a full `.jsonl` diagnostic per meeting to
  `Downloads/Platica Logs/`. Off by default.

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
