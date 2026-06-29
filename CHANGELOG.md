# Release notes

All notable changes to Plática Notes, newest first.

## Unreleased

- **Friendlier saved file.** The `.md` is now human-readable Markdown: a short
  header (title, meeting link, time, participants) followed by speaker turns as
  `**Speaker** · time` with the text as a quote. Machine metadata (schema,
  source, build) moved into a single trailing comment, out of the way.
- **Meeting link in the file.** The header now carries the Google Meet join link.
- **Caption alternatives are now opt-in.** The raw caption versions (for
  recovering words the final caption dropped) are off by default and enabled from
  Settings; the everyday file stays clean.

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

## 1.6.1 — 2026-06-19

- **Re-joined meetings are recorded again.** Leaving a call and quickly re-joining
  it in the same tab no longer drops the second visit; its transcript is saved to
  both the file and the meeting history.
- **More complete participant lists.** People who were already in the call when
  recording began are no longer intermittently missing from the saved
  participants; the list is seeded from everyone known at join time.

## 1.6.0 — 2026-06-19

- **Decluttered popup.** Clicking the toolbar icon now shows just what you reach
  for around a meeting: the "Hide all on-screen controls" toggle, a "Meeting
  history" button, and links to Settings and Help.
- **New Settings page.** Caption language, folders, the private-by-default and
  debug-log options, and the docs links moved to a dedicated, easier-to-read
  settings page — open it from the popup or from the extension's options entry.
- **Refreshed look.** A higher-contrast, Google Meet-native colour scheme across
  the popup, settings, and history, with a tuned dark theme.

## 1.5.0 — 2026-06-19

- **Read the docs inside the extension.** The popup now links to Help, What's new
  (these release notes), and the Privacy policy.
- **Hardened the saved transcript.** A multi-line chat message can no longer be
  shaped to look like a real speaker turn in the saved file, and two captions that
  land in the same instant keep their own alternatives.
- **Notes and bookmarks are saved reliably**, including a meeting where you only
  dropped bookmarks and nothing was said.
- Holding `Alt+Shift+H` / `Alt+Shift+B` no longer flickers the UI or drops a burst
  of duplicate bookmarks; the bookmark shortcut is now shown in the popup.

## 1.4.0 — 2026-06-19

- **Notes and bookmarks during a meeting.** Jot a note or drop a timestamped
  bookmark while the call is happening; both appear in the live panel and in the
  saved transcript.
- **Search the live transcript** from the in-meeting panel.
- **Hide all on-screen controls** with one toggle — from the popup or with
  `Alt+Shift+H` (`⌥⇧H` on macOS) during a meeting. Handy for screen-sharing and
  demos; recording keeps running.
- **Sticky default caption language.** New meetings start in your default; you can
  switch the language for the current meeting only from the in-meeting pill, and
  that one-off choice is not saved.

## 1.3.0 — 2026-06-19

- **New machine-oriented transcript format** — structured front matter plus a clean
  body, easier to feed to downstream tools. The saved file now records the meeting
  language and who recorded it.
- **Extension icons**, an explicit content-security-policy, and a one-command
  store-packaging build.
- **Privacy hardening** — network reading is narrowed to only what speaker-name
  resolution needs, diagnostics no longer leak any transcript text into the page by
  default, and meetings you mark private are excluded from the debug log entirely.
- **Reliability** — exports are crash-resumable, so a meeting is never silently
  lost if the browser restarts the extension mid-finalize; end-of-meeting handling
  was hardened.
- The in-meeting **privacy control** is now a clear on/off switch that fills red
  when a meeting is private; the history list shows a dash for non-private meetings.

## 1.2.0 — 2026-06-18

- **Chat is interleaved** into both the live transcript and the saved file.
- **Robust caption recovery** when Meet's native captions are toggled off and on.
- **More reliable speaker names** — remote participants and yourself — preserved
  across a mid-meeting page reload.

## 1.1.0 — 2026-06-17

- Speaker names resolved from the meeting roster.
- Cleaner raw caption history (pure upper/lower-case flicker is collapsed).

## 1.0.0 — 2026-06-17

- First stable release: live transcript plus in-meeting chat, saved locally as one
  Markdown file per meeting; a floating in-meeting transcript panel; a per-meeting
  privacy folder; a local history of recent meetings; and zero network — nothing is
  ever uploaded.
