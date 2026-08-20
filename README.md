# Plática Notes

A Chrome/Chromium extension that records **Google Meet transcripts and chat
locally** — no servers, no accounts, no network calls.

**Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/lfnfhogdkefkfjnlhhcacebleobpgecl).**
That is the build to use; it updates itself. To run an unreleased build instead, see
[docs/TEAM-INSTALL.md](docs/TEAM-INSTALL.md).

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
  speaker-attributed turns. Each turn carries the speaker, the full local
  timestamp with its UTC offset, how long the turn lasted, the elapsed time since
  the meeting started, and the text — so a tool can place any line in absolute
  time and bound a speaker's run without re-deriving either.
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
| `Downloads/Platica Notes/2026-08/` | normal meeting transcripts, one subfolder per month |
| `Downloads/Platica Notes private/2026-08/` | transcripts of meetings marked private |
| `Downloads/Platica Logs/2026-08/` | debug logs (`.jsonl`), only when debug is on |

A file is named `<date>_<time>_<title>_<meeting code>.md`, for example
`2026-08-04_15-59_Payments_status_exb-zusa-qnc.md`. The date comes first so a
folder sorts chronologically, there are no spaces, and the meeting code (absent
when the meeting has none) lets you pull every occurrence of a recurring meeting
with one glob.

### Reading the file with a tool

Every timeline line carries the same two clocks: a full local ISO 8601 instant
with its UTC offset, and the time elapsed since the meeting started as
`+HH:MM:SS`. Both are fixed width, so one pattern matches the whole file however
long the meeting ran.

Join and leave markers are `### Joined · <name> · <instant> · +<elapsed>` (and
`### Left · …`). Two rules matter when deciding who was in the room at a given
moment:

- **No join marker means the person was already there** when the recording
  started — not a missed event. Only arrivals *during* the meeting are marked;
  everyone present at the start is in the `participants` header instead. The same
  goes the other way: no leave marker means they were still there at the end.
- **Your own arrival and departure are never marked**, and neither is anything in
  the first ten seconds, which is when Meet streams the roster of people already
  in the call.

So "listed in the header, no join marker, speaks at 12:20" means present from the
start; "no marker and never speaks" means present and silent.

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

- Google Meet only.
- The caption language must match what's spoken, or the transcript comes out
  empty. Set a default in Settings; override one call from the in-meeting pill.
- A very short meeting may finalize before your name is resolved, falling back to
  a generic "Speaker N" label.

## Building from source

See `CLAUDE.md` for build, test, and architecture notes.
