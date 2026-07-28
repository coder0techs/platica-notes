# Recording toggle + Purge-so-far - design

Date: 2026-07-19
Status: approved for implementation

## Problem

A meeting can drift into content the recorder does not want captured (salary
talk, an off-topic personal aside), or the recorder may realise partway that the
whole thing was captured by mistake. Today capture is all-or-nothing for the
meeting: it runs from join to leave with no in-meeting control. We want two
in-meeting controls, both honouring the product's local-only, privacy-first
stance:

1. **Recording On / Off** - a toggle that stops/starts capturing *new*
   transcript and chat for the current meeting.
2. **Purge so far** - a destructive action that wipes everything captured in the
   current meeting up to now.

## Key decisions (settled during brainstorming)

- **Off preserves the past, captures nothing new - at all.** Turning recording
  Off stops *every* capture path for the current meeting: transcript, chat,
  participant presence markers (join/leave), AND manual notes/bookmarks.
  Whatever was captured before Off stays in the buffer and is saved to the file
  normally when the meeting ends. Off is "stop here", not "throw it away".
  Presence is gated so an Off stretch never leaves phantom "joined / said
  nothing / left" markers around a gap with no conversation. Notes are gated so
  Off literally means nothing new lands in the file.
- **Note affordance while Off is a visible no-op.** Because notes are gated,
  attempting a bookmark (Alt+Shift+B) or a panel note while Off does nothing;
  surface a brief toast ("Recording is off") so the no-op is not silent - the
  recorder typed something and must not be left thinking it saved.
- **Off and Purge are fully decoupled.** Off never deletes; Purge is the only
  destructive action. You can sit in Off and still get a file with the pre-Off
  content; or hit Purge to wipe what was captured. "Turn recording off for the
  whole meeting" = leave it Off from the start (empty buffer -> no file).
- **Off keeps the Meet captions channel subscribed.** We do NOT unsubscribe on
  Off (rejected: re-subscribing later can re-trigger Meet's "Installing <lang>"
  panel and is more fragile). Off simply drops incoming events downstream. The
  channel stays alive, so toggling On/Off is instant and reliable. Consequence:
  Meet's native Live Caption panel is unaffected by Off (it is a side effect of
  the subscription, which we keep).
- **No empty file.** Already guaranteed by `finalizeSession`
  (`src/background/sessions.ts:46`): a session with empty transcript+chat+notes
  produces no file. Off-from-start and purged-to-empty therefore write nothing.
- **Purge requires confirmation.** Destructive and irreversible, so it goes
  through a confirm step before wiping.
- **Purge scope = everything for the current meeting.** Purge clears
  `transcript`, `chat`, `rawVersions`, `notes`, and `participantEvents` - a clean
  slate. Nothing is half-kept: notes are timestamped against the transcript we
  are erasing, so keeping them would leave dangling references to deleted
  content. Purge is the "clean slate" action; if you want to keep the pre-cut
  content, use Off instead.
- **State persists per meeting.** The recording flag is stored on the session so
  a mid-meeting page reload (reload-resume) restores it - a meeting left Off must
  not silently start recording again after a reload.

## Architecture

`RtcFeed` lives in the **isolated world** (`src/content/platforms/meet.ts`), not
MAIN. MAIN (`meet-rtc/main.ts`) only decodes the protobuf and dispatches raw
`RtcEvent`s across the bridge; `meet.ts` consumes them, feeds `RtcFeed`, writes
`session.*`, and drives the UI. Both the gate and the UI are therefore in the
isolated world, in one file. **No changes to `main.ts` or the bridge**, and **no
new background message** are needed.

### Gate (Recording On/Off)

Two gate points, both in `meet.ts`, both keyed off one `recording` flag:

1. **Transcript + chat** - `activeMeetingHandler` (~line 560). Early guard before
   `feed.handleCaption` / `feed.handleChat`:

   ```
   activeMeetingHandler = (event) => {
     if (!recording && (event.type === "transcript" || event.type === "chat")) return
     ...
   }
   ```

2. **Presence markers** - `pushPresence` (~line 499). Early return so the marker
   is never appended while Off:

   ```
   const pushPresence = (name, kind) => {
     if (!recording) return
     ...
   }
   ```

- `recording` is a closure-scoped `let` in the meeting scope, initialised from
  the resumed session (`resumed?.recording ?? true`).
- When Off, transcript, chat, and presence events are dropped before they reach
  the feed / session, so the buffer, panel, and persisted session all reflect
  the gap honestly.
- Roster/name bookkeeping (`recordDevice` / `recordLeave` maintaining
  `activeByName`) still runs while Off - only the `pushPresence` append is
  gated - so join/leave state stays correct for when recording resumes.

3. **Manual notes** - `addNote` (~line 542). Early return while Off, plus a brief
   toast so the no-op is visible:

   ```
   function addNote(text) {
     if (!recording) { showToast("Recording is off"); return }
     ...
   }
   ```

   This covers both the panel input and the global Alt+Shift+B bookmark chord
   (both route through `addNote` via `addNoteToActive`).

### Purge-so-far

A closure `purge()` in the same scope. Fully local to `meet.ts`:

```
function purge() {
  feed.reset()
  prefixTranscript.length = 0
  prefixChat.length = 0
  prefixRawVersions.length = 0
  notes.length = 0
  participantEvents.length = 0
  session.transcript = []
  session.chat = []
  session.rawVersions = []
  session.notes = []
  session.participantEvents = []
  panel.update(session.transcript, session.chat, session.notes, session.participantEvents)
  writer.requestWrite()   // overwrites the persisted + crash-resume copy with the emptied state
}
```

- `RtcFeed.reset()` is a new method that clears `captions`, `chat`,
  `lastSelfChatAt`, `lastEventDeviceId`, and resets `nextOrder`. It **keeps
  `roster`** (identity, not content; needed for turns captured after purge).
- Purge clears everything for the meeting: the feed, the `prefix*` arrays (which
  on a reload-resume hold the pre-reload content), and the local `notes` /
  `participantEvents` arrays plus their `session.*` mirrors. Clearing in place
  matters so later snapshots rebuild from an empty base.
- `activeByName` (presence bookkeeping) is left intact - it is live identity
  state, not saved content; a future join/leave after purge stays correct.
- `writer.requestWrite()` persists the emptied session, so crash-resume and the
  eventual `finalizeSession` see empty -> no file.

### State persistence

- Add `recording?: boolean` to `ActiveSession` (`src/shared/types.ts`). Absent /
  `undefined` means recording (default true) - existing and legacy sessions are
  unaffected.
- The Off/On toggle sets `session.recording = recording` and calls
  `writer.requestWrite()`.
- On session start, `recording` is seeded from `resumed?.recording ?? true`.

### UI (`src/content/core/ui.ts`, `mountMeetingControls`)

Extend the existing pill group (which already hosts language + transcript-panel
+ privacy). Add:

- A **recording toggle**: a compact indicator styled like the other pills.
  On = red dot + "Rec"; Off = muted "Off" (e.g. grey/strikethrough dot). Click
  toggles. The visible state is mandatory - a silent Off is worse than no
  feature (a recorder must never think they are recording when they are not).
- A **Purge control**: a small action (icon/menu item) labelled **"Wipe
  recording"** that, on click, shows a confirm affordance (reuse the existing
  toast/confirm pattern in `ui.ts`) before calling `onPurge`. ("Wipe" over
  "Clear" - which reads as clearing the panel view - because the action is a
  destructive clean-slate and the label should say so.)

`mountMeetingControls` gains:
- `initialRecording: boolean` input.
- `onRecordingChange: (recording: boolean) => void` callback.
- `onPurge: () => void` callback (fired only after the user confirms).
- returned `setRecording(recording: boolean)` (parity with `setLanguage`), for
  any programmatic sync (e.g. a resumed session restoring Off).

`meet.ts` wires these into the closures above and updates the local `recording`
flag + `session.recording` + `writer.requestWrite()`.

## Data flow

```
Meet RTC channel
  -> main.ts (decode, dispatch RtcEvent)   [MAIN world, unchanged]
  -> bridge (CustomEvent)                   [unchanged]
  -> meet.ts activeMeetingHandler           [isolated world]
       |-- recording === false ? drop ALL capture (transcript/chat via handler, presence via pushPresence, notes via addNote) : feed it
       |-- purge(): reset feed + prefixes + notes + presence + session, persist emptied state
  -> writer -> chrome.storage (crash-resumable)
  -> finalizeSession on end: empty (no transcript/chat/notes) => no file
```

## Error handling / edge cases

- **Caption in-flight at toggle-off.** A caption already partly in the feed
  keeps whatever was captured before Off. New revisions of the *same* messageId
  that arrive after resume-On may not line up with the retained base
  (`suffixAfter` base mismatch). Accepted behaviour: treat post-resume text as a
  fresh turn; no attempt to stitch across the gap. Documented, not engineered
  around.
- **Purge mid-utterance.** `feed.reset()` drops the in-progress caption too; the
  next revision starts a fresh entry. Fine.
- **Privacy flag interaction.** Untouched. A private meeting still routes to the
  private folder and stays out of the debug log on every path, including after a
  purge or in Off.
- **Reload-resume while Off.** `session.recording` restores the Off state; the
  gate re-applies; the pill shows Off via `setRecording`.
- **Presence during Off.** Join/leave that happen while Off produce no marker
  (dropped in `pushPresence`); `activeByName` still tracks them, so a resume-On
  sees correct current state. No backfill of markers missed during Off.
- **Manual note during Off.** Gated: `addNote` no-ops and shows a "Recording is
  off" toast. Nothing new lands in the file while Off.
- **After purge.** Everything is cleared, so an immediately-finalized meeting is
  empty and produces no file. New content captured after purge starts fresh.

## Testing

Follow the project pattern: keep decision logic pure and covered.

- **`RtcFeed.reset()`** (`tests/feed.test.ts` or equivalent): after capturing
  some captions + chat, `reset()` yields empty `transcriptSnapshot()` /
  `chatSnapshot()` / `versionsSnapshot()`; roster is retained; a caption captured
  after reset resolves its speaker via the retained roster.
- **Gate logic**: extract the drop decision as a tiny pure helper
  (e.g. `shouldRecord(recording, eventType)` in a testable module, mirroring
  `meet-lifecycle.ts`) and unit-test that transcript/chat are dropped when Off
  and non-conversation events are unaffected.
- **Empty finalize**: existing `finalizeSession` empty-session behaviour already
  covered; add/confirm a case that a purged (empty) session produces no file.
- No DOM/UI unit tests beyond wiring; the pill is glue.

## Out of scope (YAGNI)

- Unsubscribing the captions channel on Off / hiding Meet's native panel.
- Separate "Pause" vs "Off" states (collapsed into one On/Off toggle).
- Purging previously finalized meetings (Purge is current-meeting only).
- Per-segment / time-range redaction of the transcript.
