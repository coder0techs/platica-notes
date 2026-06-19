# Release notes

All notable changes to Plática Notes, newest first.

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
