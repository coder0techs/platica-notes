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

- Live transcript + in-meeting chat, saved as a readable Markdown `.md` per
  meeting: a short header (title, meeting link, time, participants) followed by
  speaker-attributed turns. Each turn shows the speaker, the time, and the text.
- **In-meeting transcript panel** — a floating, scrollable live transcript inside
  the Meet window, so you can scroll back and re-read without leaving the call.
  Includes a **search box** that filters the timeline, and a footer input to add
  your own **notes**.
- **Bookmarks & notes** — drop a timestamped bookmark with **Alt+Shift+B**
  (**⌥⇧B** on macOS), or type a note in the panel; both land on the timeline in
  context and are written into the saved file as `###` heading blocks, distinct
  from speaker turns.
- **Hide all on-screen UI** — a popup toggle and **Alt+Shift+H** (**⌥⇧H** on
  macOS) hide every extension element (controls, panel, toasts) for
  screen-sharing or demos; recording keeps running while hidden.
- **Caption alternatives** (Settings, on by default): each turn also records the
  raw versions Google streamed before the final caption, so words the final
  caption dropped can still be recovered later. Turn it off for a cleaner file.
- Speaker-attributed lines (others and yourself), with the closing sentence
  captured in full on leave. Chat is captured too — both what others send and
  the messages you send yourself.
- **Participant join/leave markers** — when someone joins or leaves during the
  meeting it is marked inline on the timeline with a timestamp (in the speaker's
  colour), not just as the final participant list in the header.
- **Default caption language** (Settings) — every new meeting starts in this
  language; the in-meeting language pill overrides just the current meeting and is
  not saved. A first-run welcome page lets you pick it; fresh installs default to
  English.
- **Recording toggle** (● Rec / ⏸ Rec off): pause and resume capture without
  leaving the call. Off stops everything new — transcript, chat, join/leave
  markers, and notes — while whatever was captured before you turned it off is
  still saved when the meeting ends. The state survives a page reload.
- **Wipe recording** (🗑): clears everything captured in the current meeting so
  far (transcript, chat, notes, presence markers). Click once to arm, once more
  to confirm. If nothing remains afterwards, no file is written.
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

If a meeting could not be captured properly — captions never started, or the stream
dropped and could not be restored — the file says so in its header (`capture:`) and
the extension tells you in the call while it is happening. A thin transcript is never
left looking like it is all that was said.

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
- **Caption alternatives.** Adds the raw caption versions under each turn for
  recovering dropped words. On by default; turn off for a cleaner file.
- **Merge rejoined visits.** If you accidentally leave and rejoin the same
  meeting within ~40 minutes, the visits are folded into one `.md` instead of one
  file per visit. On by default; turn off to keep one file per visit. A daily
  recurring call is never merged across days, and a private visit is never folded
  into a public file.
- **Ask language at meeting start.** Shows a prompt when each meeting begins to
  confirm or switch the caption language. Off by default — for people who meet in
  several languages. It never blocks recording.
- **Debug log.** Writes a full `.jsonl` diagnostic per meeting to
  `Downloads/Platica Logs/`. Off by default. Private meetings are never logged.

## Scope & limitations

- Google Meet is fully supported. **Zoom is experimental** and off by default: turn
  it on in Settings, which asks for access to zoom.us. It records the transcript,
  the meeting title and join/leave markers — not the in-meeting chat, and it has no
  caption-language picker.
- **Only meetings you join in this browser can be recorded.** The Zoom and Teams
  desktop apps are invisible to any browser extension, so a call joined in the app
  records nothing. On Zoom, use "Join from your browser".
- On Zoom, live transcription is switched on by the meeting **host**. With it off
  there are no captions to read; the extension says so in the call and notes the
  reason in the file rather than saving an empty transcript.
- Microsoft Teams is not supported yet.
- The caption language must match what's spoken, or the transcript comes out
  empty. Set a default in Settings; override one call from the in-meeting pill
  (Meet only).
- A very short meeting may finalize before your name is resolved, falling back to
  a generic "Speaker N" label.

## Building from source

See `CLAUDE.md` for build, test, and architecture notes.
