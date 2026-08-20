# Plática Notes

## User manual

Plática Notes records your Google Meet transcript and in-meeting chat and saves it
as a Markdown file on your own computer. No servers, no accounts, no network
requests: the extension has nowhere to send anything, by design.

This manual covers version 1.14.0, the version published on the Chrome Web Store.

---

## 1. What you get, and what you do with it

At the end of a call one `.md` file appears in your Downloads folder. It holds the
facts of the meeting and nothing else: who spoke, when, what was said, the chat in
the same timeline, your own notes, and who joined or left mid-call.

The extension deliberately does **not** write a summary. Summarising is where tools
decide for you what mattered, and it is also where your meeting would have to be
uploaded to somebody's API. Instead you get the raw material and pass it to whatever
assistant you already use, with your own prompt: minutes, decisions, action items, a
follow-up email, or an answer to one specific question. Nothing leaves your machine
until you decide to send it.

The file format is designed for exactly that hand-off (see section 7).

### Requirements

Chrome, Arc, or any Chromium-based browser. Google Meet only. Nothing else to set
up: no sign-in, no bot joining your call, no third participant for anyone to see.

---

## 2. Quick start

1. Install from the Chrome Web Store and open a Google Meet call.
2. Check the language pill at the top of the meeting (`🌐 English (US)`). **It must
   match the language actually being spoken**, otherwise the transcript comes out
   empty. Set your usual language once in Settings; use the pill to override a
   single call.
3. Talk. Capture runs from the moment you join; there is nothing to press. Meet's
   own on-screen caption band does not need to be turned on.
4. Click `📄 Transcript` to watch the transcript build up live, if you want to.
5. Leave the call. The file is written to
   `Downloads/meetings/platica-notes/<meeting title> <date>.md`.

If a meeting produced nothing (nobody spoke, or you wiped it), no file is written.

---

## 3. The controls inside the meeting

A row of pills sits at the top of the meeting window.

![The in-meeting controls and the live transcript panel](panel.png)

| Control | What it does |
|---|---|
| `🌐 English (US)` | Caption language **for this meeting only**. Changing it here does not change your default, and the next meeting starts from your Settings value again. |
| `📄 Transcript` | Shows and hides the live transcript panel. |
| `● Rec` / `⏸ Rec off` | Pauses and resumes capture. Red means recording. |
| `🗑 Wipe` | Erases everything captured in this meeting so far. |
| `🔒 Private` / `☁️ Normal` | Marks this meeting private, so its file goes to the private folder. |

### Language

The single most common cause of an empty transcript is a language mismatch. Google
generates captions for one language at a time, and if the pill says English while the
call is in Russian, there is simply nothing to capture. Switching the pill
mid-sentence is fine: capture re-subscribes to the new language and keeps going.

If you regularly move between languages, turn on **Ask language at meeting start** in
Settings. Each meeting then opens with a small prompt: keep the current language,
pick another, or dismiss it. It never blocks recording.

### Recording on and off

`● Rec` is on when you join. Click it and everything new stops: transcript, chat,
join/leave markers, notes. Whatever was already captured is kept and still saved when
the meeting ends, and the off state survives a page reload, so an accidental refresh
does not silently start recording you again.

Use it for the part of the call that should not exist in writing.

![Capture paused, and Wipe armed and waiting for confirmation](recording.png)

### Wipe

`🗑 Wipe` throws away everything captured in the current meeting so far. Click once
to arm it (it turns yellow and reads `🗑 Wipe? confirm`), click again to confirm; if
you do nothing it disarms itself. If nothing is left afterwards, leaving the meeting
writes no file at all.

Wipe is per-meeting and immediate. It does not touch files already saved from earlier
meetings; delete those from Downloads or from the history page.

### Private meetings

`🔒 Private` routes this meeting's file to a separate folder
(`meetings/platica-notes-private` by default) so you can keep it out of whatever you
sync to the cloud. A private meeting is also excluded from the diagnostic log
entirely, even when that log is switched on.

If most of your calls are sensitive, set **Private by default** in Settings and use
the pill for the exceptions.

### Hiding everything

**Alt+Shift+H** (**⌥⇧H** on macOS) hides every element the extension draws: pills,
panel, toasts. Recording keeps running. The same toggle lives in the toolbar popup.
Use it before you share your screen. Press it again to bring the controls back.

---

## 4. The live transcript panel

`📄 Transcript` opens a floating card with the meeting timeline as it fills.

- **Speaker turns** appear on the left, each speaker in their own colour.
- **Chat messages** are aligned to the right, so a written message never looks like
  something that was said out loud.
- **Join and leave markers** (`👋 … joined`, `🚪 … left`) also sit on the right, in
  the participant's colour.
- **Your notes** appear inline where you added them.

Things worth knowing:

- **Search.** The box in the panel header filters the timeline as you type, matching
  both speaker names and text. Clear it to see everything again. Handy when someone
  asks "what did we decide about the invoice?" in the middle of a call.
- **Move and resize.** Drag the card by its header to get it out of the way of a
  shared screen; drag the bottom-right corner to resize it.
- **Follow or read back.** The panel sticks to the newest line while you are at the
  bottom. Scroll up to read and it stops jumping; a `↓ Jump to latest` button appears
  to take you back.
- **Notes.** Type in the footer field and press Enter (or click `＋`). The note is
  timestamped at the moment you add it and lands on the timeline in context, both in
  the panel and in the saved file.
- **Bookmarks.** **Alt+Shift+B** (**⌥⇧B**) drops a bookmark with no text: a marked
  moment, for when you have no time to type. It becomes a `### Bookmark` block in the
  file, so an assistant can be told to pay attention to what was said around it.

Closing the panel with `✕` only hides it. Capture is unaffected.

---

## 5. Settings

Open the toolbar popup and click **⚙ Settings**. The popup itself keeps only the
in-the-moment control (hide on-screen controls) plus links to the history and this
page.

![The settings page](settings.png)

### Recording

- **Default caption language.** Seeds every new meeting. Fourteen languages are
  available, including Russian, English (US/UK), Spanish (Spain/Mexico), Portuguese
  (Brazil/Portugal), French, German, Italian, Dutch, Polish, Ukrainian and Kazakh.
  Fresh installs default to English (US).
- **Mark meetings private by default.** New meetings start private.

### Folders

Three paths, all relative to your browser's Downloads folder. Nested paths such as
`work/meetings` are allowed.

| Setting | Default | Contents |
|---|---|---|
| Public folder | `meetings/platica-notes` | Normal meeting transcripts |
| Private folder | `meetings/platica-notes-private` | Transcripts of meetings marked private |
| Debug-log folder | `meetings/platica-notes-logs` | Diagnostic logs, only when the debug log is on |

If you sync transcripts to the cloud, sync the public folder only. The private folder
holds the meetings you deliberately kept out, and debug logs embed the full
transcript.

### Advanced

- **Caption alternatives in the saved file** (on by default). Google rewrites its
  captions as it hears more, and the final version sometimes drops words that an
  earlier version had. With this on, each turn also carries those earlier versions as
  `↳ _alt:_` lines, so a word lost from the final caption can still be recovered
  later, by you or by an assistant. Turn it off for a shorter, cleaner file.
- **Merge rejoined visits into one file** (on by default). If you drop out and rejoin
  the same meeting within 40 minutes, both visits end up in one file (with a
  `## Visit 2 · rejoined …` heading) instead of two. A daily recurring call is never
  merged across days, and a private visit is never folded into a public file.
- **Ask language at meeting start** (off by default). See section 3.
- **Debug log** (off by default). Writes a `.jsonl` diagnostic file per meeting,
  containing the full transcript plus decoding details. Only useful when reporting a
  capture problem. Private meetings are never logged. Turn it off when you are done.

---

## 6. Meeting history

The popup's **Meeting history** button opens a local list of your recent meetings
(the last 30; older ones fall off as new ones arrive).

![The meeting history page](history.png)

Each row shows when the meeting started, its title, how many turns were captured, and
whether it was private. **Download** writes the `.md` again, which is the fix for a
file you deleted by accident or a download you dismissed. **Delete** removes the
meeting from this local history; it does not delete a file already in Downloads.

Everything on this page lives in your browser profile on this machine.

---

## 7. The saved file

The file has a YAML front matter header and a body of turns.

The header carries the meeting title, the Meet link, the chat link, the caption
language, your time zone, the exact start and end times, who recorded it, and the
participant list. Then a comment line records the extension version and the format
schema, so a downstream tool can tell which grammar it is reading.

![A saved transcript](saved-file.png)

The body is one block per event, in chronological order:

| Block | Meaning |
|---|---|
| `**Name** · 09:02 · +00:12` | A spoken turn. Clock time, then elapsed time from the start of the meeting. The text follows on a `>` line. |
| `**Name** · _chat_ · …` | A chat message rather than speech. |
| `**Speaker 3** · _unresolved_ · …` | Someone whose display name never arrived (see section 9). |
| `> ↳ _alt:_ …` | An earlier version of the caption above it, when caption alternatives are on. |
| `### Note · 09:04 · +02:38` | A note you typed. |
| `### Bookmark · …` | A bookmark you dropped with Alt+Shift+B. |
| `### Joined · Name · …` / `### Left · …` | Someone joined or left mid-meeting. |
| `## Visit 2 · rejoined …` | The start of a second visit, in a merged file. |

### Using it with an assistant

Drag the file into Claude, ChatGPT, or a local model and ask for what you actually
need. Some prompts that work well:

- "From this transcript, write minutes: decisions, owners, deadlines. Quote the line
  each decision came from."
- "List only the action items assigned to me, with the context of each."
- "What did we agree about pricing? Ignore everything else."
- "Draft a follow-up email to the client summarising what we committed to."
- "Some turns have `↳ _alt:_` lines with earlier caption versions. Where the final
  text looks garbled, use them to reconstruct the sentence."

Because the file is plain Markdown with an explicit schema, none of this depends on a
particular model or vendor.

---

## 8. Privacy

- **The extension makes no network requests of its own.** No servers, no analytics,
  no telemetry, no accounts. There is no code in it that can send your transcript
  anywhere.
- **Everything is stored on your machine**: the files in Downloads, the recent-meeting
  history in your browser profile.
- **The privacy flag is honoured on every output path**: a meeting marked private
  goes to the private folder and is excluded from the diagnostic log.
- **You can stop and erase**: `⏸ Rec off` stops capture mid-call, `🗑 Wipe` throws
  away what has been captured, and a meeting with nothing captured produces no file.
- Uninstalling the extension removes its stored data. Files already in Downloads are
  yours and stay.

The published privacy policy is linked from the Chrome Web Store listing.

**One thing that is on you:** recording a meeting may require the consent of the other
participants, depending on where you are. Tell them.

---

## 9. When something looks wrong

**The file is empty, or there is no file at all.**
The caption language did not match what was spoken. Check the language pill during
the next call. Also check that somebody actually spoke: a meeting with no captured
content writes no file by design.

**A speaker is called "Speaker 2" instead of their name.**
Names arrive from Meet's own roster, and in a very short call, or if you join late,
that data can be missing for someone. The transcript is still correct; only the label
is generic, and it is tagged `_unresolved_` in the file so you can fix it afterwards.

**Nothing was captured after I turned Meet's captions off (or on).**
That is handled: capture reads the meeting's data stream directly, and re-establishes
it if Meet tears it down. If you do see a gap, that is worth reporting.

**A banner says the extension was updated and I should rejoin.**
The browser replaced the extension while you were in a call, which cuts the running
capture off from the part that saves files. Rejoin the meeting so the rest of it is
recorded. What was captured before is not lost.

**I refreshed the page mid-meeting.**
Capture resumes and the meeting stays one file. A paused recording stays paused.

**Two transcripts appeared for one meeting.**
Either you left and rejoined more than 40 minutes apart (they are separate meetings
by then), or **Merge rejoined visits** is off, or you have two copies of the extension
installed: one from the store and one loaded unpacked. Two copies capture
independently and both write files; remove one.

**Reporting a problem.** Turn on the **Debug log** in Settings, reproduce the
problem, and send the `.jsonl` file from `meetings/platica-notes-logs`. It contains
the full transcript of that meeting, so use a meeting you do not mind sharing, and
turn the setting off afterwards. Private meetings are never logged.
