# Release notes

All notable changes to Plática Notes, newest first.

## Unreleased

- **The release notes no longer open with an empty heading.** This page carried an
  "Unreleased" heading above the newest version with nothing under it, which reads as
  something that failed to load rather than as the placeholder it is.

## 1.16.0 - 2026-08-21

- **Every screen has been redesigned.** One visual language now runs through the
  popup, settings, history, the first-run page, the documentation pages and the
  in-meeting overlay, and it is taken from what the extension produces: a saved
  meeting is a sequence of speaker-attributed turns (a coloured name, a
  monospace clock, a body), so every group on every screen is drawn the same way,
  and the colours are the ones the live transcript panel already used for
  speakers. Times, counts, folder paths and language tags are set in monospace
  throughout, because they are data. Red now means exactly two things and nothing
  else: capture is live, or this control destroys something.

- **The toolbar popup finally answers the question you opened it to ask.** It
  showed a screen-sharing toggle and a link. It now leads with the meeting: whether
  capture is running, how long it has been running, the title, the language, whether
  the meeting is private, and the exact folder the file will land in. Between calls
  it names the last meeting it saved. Hiding the on-screen controls is still one
  click, just no longer the most prominent thing on the surface.

- **Deleting a meeting can be taken back.** It used to be a browser confirmation
  box and then gone for good, on a transcript that exists nowhere else in the
  extension. The row now goes immediately and an **Undo** stays available for ten
  seconds, which is the protection the dialog was pretending to be. Re-downloading
  a meeting also reports where the file landed instead of succeeding in silence.

- **Meeting history is a list you can search.** Titles no longer get squeezed into
  a table column: meetings are grouped by month, newest first, with a filter box, a
  private-or-not marker, the turn count and the caption language on each row, and a
  button that opens your Downloads folder. Its empty state now says what to do
  instead of showing an empty table header.

- **You can see how many meetings history keeps, and change it.** The limit was
  fixed at thirty and mentioned nowhere, so the thirty-first meeting silently
  pushed the oldest out of the list. It is now a setting, and both the history page
  and the setting say plainly that the `.md` files already in your Downloads folder
  are never touched.

- **Settings tells you it saved, and shows you the path before you commit to it.**
  Eight controls wrote to storage without a word of acknowledgement. Each group now
  also carries its own current value on its heading, so the whole configuration can
  be read without opening a control, and each folder field previews the exact path
  the download will use, including when what you typed would be rewritten, which
  previously only surfaced as a file in an unexpected place hours later.

- **Help is the user manual.** The Help link opened the project's README: install
  from source, architecture notes, contributor instructions. It now opens the actual
  manual, with its figures, and the manual, release notes and privacy policy can
  reach each other and get back to the extension.

- **The first-run page explains the product instead of asking one question.** It
  now says what happens in three steps (join a call, watch or annotate the
  transcript, find the file in Downloads), and lets you pin the two or three
  languages you meet in, which is the setting that makes the in-meeting controls
  worth using and which was previously buried.

- **The confirmation on Wipe can be read.** Armed, it was red text on an amber
  fill, at the one moment it had to be legible, and it did not say what the next
  click would do. It is now dark ink on amber and says so.

- **The in-meeting controls work from the keyboard, and say what the keys are.**
  The overflow menu opens with the arrow keys, walks its rows with them and closes
  with Escape, giving focus back where it came from; every control everywhere now
  has a visible focus ring, which the overlay had nowhere at all. The menu also
  names the two shortcuts (mark this moment, hide the controls) where the
  question actually comes up rather than only in Settings. Choosing something in
  the menu now closes it.

- **On-screen confirmations get out of the way in three seconds.** They used to sit
  there for eight, four or five depending on which one it was, over somebody's face
  on a live call, repeating what the permanent recording pill already says. One
  duration now, and anything that actually needs acting on is a notice that does not
  auto-dismiss at all rather than a toast that vanishes.

- **The recording pill carries the elapsed time.** A clock that has stopped moving
  says something is wrong sooner than any warning can.

- **Anything that moves respects "reduce motion", and the language picker works in
  dark mode.** The pinned-language chips were hard-coded white on white text, so on
  a dark settings page they were an unreadable stripe of foreign UI.

- **The "not recording speech" notice no longer cries wolf.** It could appear on a
  meeting that was recording perfectly, and once shown it stayed on screen into
  the next meeting in that tab. It now goes away by itself if recording turns out
  to be fine, and never outlives the meeting it belongs to.

- **Recording now survives another meeting recorder in the same tab.** With a
  second recording extension installed, Plática Notes captured nothing at all —
  no speech, no participants, nothing. It saw one of the fourteen channels Google
  Meet opens, and not the one captions arrive on, so it never asked for them. It
  now attaches to each connection directly instead of assuming it is the only
  extension on the page, and works alongside the other recorder rather than
  needing it turned off.

- **The in-meeting controls are down to what you need mid-call.** The bar showed
  eight buttons on top of your meeting; it now shows whether it is recording, your
  language buttons, and a menu. The recording pill also carries the padlock when a
  meeting is private, so hiding that toggle does not hide the state. Everything
  else — the full language list, the transcript panel, the private toggle — moved
  into the menu. **Wipe** moved there too, and that one is not about tidiness: it
  is the only control that destroys what has been captured, and it no longer sits
  a stray click away from the language buttons. It still asks before it fires.

- **A meeting that is not recording speech now says so.** This used to fail
  silently: the meeting ran, the panel stayed empty, and the first sign was a
  missing file afterwards. A notice now appears while there is still time to fix
  it, and it names the usual cause — a second meeting-recorder extension in the
  same tab, since only one of them can read Meet's captions. It does not fire on a
  quiet meeting: a call where nobody has spoken yet is normal and stays silent.

- **Links in the live panel are clickable.** A link someone pastes into the meeting
  chat used to be plain text you had to retype. It now opens in a new tab — never
  the current one, which would leave the call. Only `http` and `https` links become
  clickable, nothing is prefetched or previewed, and the address the meeting is on
  is not passed to the site you open.
- **A button per language you actually use.** Pick up to three in Settings and each
  one gets its own flag button in the meeting, so switching the recording language
  is a single click instead of a trip through a list of fourteen. Nothing is hidden:
  the full list stays in the meeting's menu, for the call you did not see coming.
- **The debug log now says what produced it.** Each log starts with the extension
  version and build, the browser, and the settings that decide what capture does.
  Diagnostic events from the first moments of a meeting are no longer dropped
  either — which is exactly the part worth reading when capture fails to start.
  It also counts what happened to the captions: how many arrived, how many the
  decoder could read, and how many were saved. A gap between those numbers is
  the difference between "nobody spoke" and "something is broken", which until
  now nothing recorded.

- **The language list is in Google Meet's own order.** It used to open with whichever
  language happened to have been typed into the list first, which is no way to decide
  what fourteen people from fourteen places see at the top. It now follows the order
  Meet's own caption settings use, so a language is where you already expect it and no
  one market leads by accident. Pinning is how a language gets to the top, per
  profile, and the default for a fresh install is unchanged.

## 1.15.0 - 2026-08-20

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
