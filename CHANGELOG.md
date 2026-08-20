# Release notes

All notable changes to Plática Notes, newest first.

## Unreleased

- **Saved meetings are filed by month.** Transcripts now land in a `YYYY-MM`
  subfolder of your chosen folder instead of piling into one flat directory.
  Debug logs follow the same split. Files saved earlier stay where they are.
- **New file names.** A saved meeting is now
  `2026-08-04_15-59_Payments_status_exb-zusa-qnc.md`: date first so a folder
  sorts chronologically, no spaces anywhere, and the meeting code at the end so
  every occurrence of a recurring meeting can be pulled with one glob. The code
  is left out when the meeting has none.
- **The elapsed offset is now always `+HH:MM:SS`.** It used to be `+05:12` for the
  first hour and `+1:00:41` after it, so a tool written against a short meeting
  matched the beginning of a long one and silently skipped the rest. One shape now
  covers the whole file, and the offsets sort as plain strings.
- **Each turn carries a full timestamp and its duration.** A turn header was
  `15:59 · +05:12`; it is now the complete local time with UTC offset, how long
  the turn lasted, and the elapsed offset. A tool reading the file no longer has
  to add the offset to the header's start time to know when something was said,
  and can tell where a speaker's turn ended instead of guessing from the text.
  Chat messages, notes and join/leave markers are instants, so they carry no
  duration.
- **Participants without a full name are no longer dropped.** Meet does not always
  send a participant's full name — guests, dial-ins and some external participants
  arrive with only a short display name, and those people were skipped entirely:
  missing from the participant list, with their speech left under a "Speaker N"
  label. The short name is now used when the full one is absent.
- **A packet carrying several roster updates is now read in full.** Joins and
  departures can arrive batched, and only the first entry of such a packet was
  decoded; the rest were learned late or not at all, which could put a
  participant's join at the wrong moment. Every record in a packet is now read,
  on both the join and the leave path.

## 1.14.1 - 2026-08-14

- **Speakers Meet names late are no longer stuck as "Speaker 360".** Meet does not
  always announce a participant's name while they are in the call — on an observed
  meeting it sent two people's names for the first time only as they left. Their
  turns now pick up the real name as soon as it arrives, and the saved file's
  participant list no longer omits people whose speech is in the transcript.

## 1.14.0 - 2026-07-29

- **Recording on/off toggle.** A new in-meeting pill (● Rec / ⏸ Rec off) pauses
  and resumes capture without leaving the call. Turning it off stops everything
  new — transcript, chat, join/leave markers, and notes — and the state survives
  a page reload. Whatever was captured before you turned it off is still saved
  when the meeting ends.
- **Wipe recording.** A new in-meeting pill (🗑) clears everything captured in the
  current meeting so far — transcript, chat, notes, and presence markers. Click
  once to arm it, once more to confirm. A meeting left with nothing captured
  writes no file.

## 1.13.1 - 2026-07-09

- **Leave markers are now immediate and reliable.** They previously lagged by a
  minute or two, or were missed entirely, because they keyed off Meet's delayed
  device-removal signal. They now fire within about a second of someone leaving,
  matching Meet's own People panel.
- **The chat link in the saved file is now openable.** 1.13.0 recorded a raw
  embedded-frame URL that did not open; the front matter now carries a clean
  `chat.google.com` link to the meeting's conversation.

## 1.13.0 - 2026-07-09

- **Chat from other participants is now captured.** Their in-meeting chat
  messages were never recorded before. The transcript now includes the full
  meeting chat, from every participant and from you, read locally and never
  transmitted, with duplicates filtered out.
- **Inline join and leave markers.** The transcript now notes when someone joins
  or leaves during the meeting, inline on the timeline with a timestamp and in the
  speaker's colour, instead of only the final participant list in the header.
- **A notice when the extension is updated mid-meeting.** If the extension is
  reloaded or updated during a call, an on-screen banner now tells you to rejoin
  so the meeting is saved, instead of failing silently.
- **More faithful transcript order.** When a speaker is interrupted and keeps
  talking, their later words no longer sort back into their earlier paragraph, and
  a new paragraph starts after a long pause, in the live panel and the saved file
  alike.
- **A chat link in the saved file.** The header now carries a link to the
  meeting's Google Chat conversation, so a downstream tool can reach attachments or
  messages that are not in the transcript.
- **Panel fixes.** The live panel keeps its place when you have scrolled up, and
  the "jump to latest" pill no longer overlaps the note input.

## 1.12.0 - 2026-06-30

- **Merging rejoined visits is now on by default.** An accidental leave and rejoin
  of the same meeting is the common case, and merging is reversible (no content is
  lost), so it now happens out of the box. The merge window is also tightened to
  about 40 minutes (from 2 hours) so a persistent meeting "room" reused for a
  different, later call is not merged by mistake. Turn it off in Settings to keep
  one file per visit.

## 1.11.1 - 2026-06-30

- **Language prompt polish.** The start-of-meeting language prompt no longer
  overlaps the in-meeting notices, closes as soon as you pick a language (in the
  prompt or via the pill), and applies your choice in one click: picking a language
  in its list is enough, with no extra confirm step. Also removed a hard-to-read
  header from the caption-language dropdown.

## 1.11.0 - 2026-06-30

- **Optional language prompt at meeting start.** For people who meet in several
  languages and forget to switch: turn on "Ask which language to use at the start
  of each meeting" in Settings and a prompt appears as each meeting begins, letting
  you confirm or switch the caption language before it records in the wrong one.
  Off by default; it never interrupts recording, and has a "Don't ask again" link.

## 1.10.0 - 2026-06-30

- **Optionally merge rejoined visits into one file.** If you accidentally leave
  and rejoin the same meeting within a couple of hours, the visits can be folded
  into a single `.md` instead of one file per visit. Off by default; enable
  "Merge rejoined visits into one file" in Settings. A daily recurring call
  (same link every day) is never merged across days, and a private visit is never
  folded into a public file. Each rejoin is marked in the file with a
  `## Visit N · rejoined …` heading, and the History list shows the visit count.

## 1.9.0 - 2026-06-30

- **More reliable end-of-meeting saving.** The transcript is now finalized from
  Google Meet's own call connection rather than only watching the on-screen
  "leave" button. Your meeting still saves if Meet changes its interface, and it
  saves a couple of seconds sooner when a call ends without you clicking Leave
  (you were removed, or the host ended the call). The previous on-screen checks
  stay in place as a backup, so nothing regresses.

## 1.8.0 - 2026-06-29

- **Friendlier saved file.** The `.md` is now human-readable Markdown: a short
  header (title, meeting link, time, participants) followed by speaker turns as
  `**Speaker** · time` with the text as a quote. Machine metadata (schema,
  source, build) moved into a single trailing comment, out of the way.
- **Meeting link in the file.** The header now carries the Google Meet join link.
- **Notes and bookmarks stand out.** Recorder notes and bookmarks now render as
  their own `###` heading blocks instead of speaker-style turns, so they stand
  apart in the transcript and no longer read as a participant.
- **Caption alternatives are now a setting.** The raw caption versions (for
  recovering words the final caption dropped, or for an AI to reconstruct the
  exact wording) render as quoted `↳ _alt:_` lines under each turn. On by
  default; turn off in Settings for a cleaner file.

## 1.7.2 - 2026-06-29

- **Simpler in-meeting notices.** The toasts and the Settings "meeting in progress"
  note now use a plain soft fill instead of an accent edge, and the
  language-change confirmation shows for 4 seconds.
- **Cleaner Help.** The in-extension Help page now covers just how to use the
  extension; build and development notes moved out of it. The first-run welcome
  page also links to Help.

## 1.7.1 - 2026-06-29

- **More visible in-meeting notices.** The "recording" and language-change toasts
  now use a soft accent style instead of plain black, and the Settings note shown
  while a meeting is recording is highlighted, so both are easier to spot. The
  language-change confirmation is also briefer (5 seconds).

## 1.7.0 - 2026-06-29

- **First-run setup.** Installing the extension now opens a short welcome page to
  pick your default caption language before your first meeting.
- **Clearer caption-language scope.** The in-meeting language picker spells out that
  a change applies to the current meeting only and confirms it with a brief notice,
  and the Settings page now points out, while a meeting is recording, that changing
  the default applies to new meetings rather than the one in progress.

## 1.6.3 - 2026-06-29

- **Back-to-back meetings are both saved.** Leaving a call and then joining a
  *different* meeting in the same tab no longer loses the first one. Its
  transcript is now finalized to both the file and the meeting history before the
  next meeting can overwrite it.

## 1.6.2 - 2026-06-24

- **Leaner transcript files.** Caption revisions that differ only in
  capitalization or punctuation are no longer saved as `alt:` lines; only genuine
  wording changes are kept, so the raw-versions section is much smaller.

## 1.6.1 - 2026-06-19

- **Re-joined meetings are recorded again.** Leaving a call and quickly re-joining
  it in the same tab no longer drops the second visit; its transcript is saved to
  both the file and the meeting history.
- **More complete participant lists.** People who were already in the call when
  recording began are no longer intermittently missing from the saved
  participants; the list is seeded from everyone known at join time.

## 1.6.0 - 2026-06-19

- **Decluttered popup.** Clicking the toolbar icon now shows just what you reach
  for around a meeting: the "Hide all on-screen controls" toggle, a "Meeting
  history" button, and links to Settings and Help.
- **New Settings page.** Caption language, folders, the private-by-default and
  debug-log options, and the docs links moved to a dedicated, easier-to-read
  settings page, opened from the popup or from the extension's options entry.
- **Refreshed look.** A higher-contrast, Google Meet-native colour scheme across
  the popup, settings, and history, with a tuned dark theme.

## 1.5.0 - 2026-06-19

- **Read the docs inside the extension.** The popup now links to Help, What's new
  (these release notes), and the Privacy policy.
- **Hardened the saved transcript.** A multi-line chat message can no longer be
  shaped to look like a real speaker turn in the saved file, and two captions that
  land in the same instant keep their own alternatives.
- **Notes and bookmarks are saved reliably**, including a meeting where you only
  dropped bookmarks and nothing was said.
- Holding `Alt+Shift+H` / `Alt+Shift+B` no longer flickers the UI or drops a burst
  of duplicate bookmarks; the bookmark shortcut is now shown in the popup.

## 1.4.0 - 2026-06-19

- **Notes and bookmarks during a meeting.** Jot a note or drop a timestamped
  bookmark while the call is happening; both appear in the live panel and in the
  saved transcript.
- **Search the live transcript** from the in-meeting panel.
- **Hide all on-screen controls** with one toggle, from the popup or with
  `Alt+Shift+H` (`⌥⇧H` on macOS) during a meeting. Handy for screen-sharing and
  demos; recording keeps running.
- **Sticky default caption language.** New meetings start in your default; you can
  switch the language for the current meeting only from the in-meeting pill, and
  that one-off choice is not saved.

## 1.3.0 - 2026-06-19

- **New machine-oriented transcript format:** structured front matter plus a clean
  body, easier to feed to downstream tools. The saved file now records the meeting
  language and who recorded it.
- **Extension icons**, an explicit content-security-policy, and a one-command
  store-packaging build.
- **Privacy hardening:** network reading is narrowed to only what speaker-name
  resolution needs, diagnostics no longer leak any transcript text into the page by
  default, and meetings you mark private are excluded from the debug log entirely.
- **Reliability:** exports are crash-resumable, so a meeting is never silently
  lost if the browser restarts the extension mid-finalize; end-of-meeting handling
  was hardened.
- The in-meeting **privacy control** is now a clear on/off switch that fills red
  when a meeting is private; the history list shows a dash for non-private meetings.

## 1.2.0 - 2026-06-18

- **Chat messages appear inline** in the live transcript and the saved file.
  (Reliable capture of other participants' chat came later, in 1.13.0.)
- **Robust caption recovery** when Meet's native captions are toggled off and on.
- **More reliable speaker names**, for remote participants and yourself, preserved
  across a mid-meeting page reload.

## 1.1.0 - 2026-06-17

- Speaker names resolved from the meeting roster.
- Cleaner raw caption history (pure upper/lower-case flicker is collapsed).

## 1.0.0 - 2026-06-17

- First stable release: live transcript plus in-meeting chat, saved locally as one
  Markdown file per meeting; a floating in-meeting transcript panel; a per-meeting
  privacy folder; a local history of recent meetings; and zero network, so nothing
  is ever uploaded.
