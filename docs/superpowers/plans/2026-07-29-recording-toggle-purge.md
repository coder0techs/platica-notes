# Recording toggle + Wipe recording - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two in-meeting controls to the Meet capture UI - a Recording On/Off toggle that stops all new capture, and a "Wipe recording" action that clears everything captured so far.

**Architecture:** Both gate and UI live in the isolated world. `meet.ts` holds one `recording` flag (persisted on the session for reload-resume) and gates the three capture paths (transcript/chat handler, `pushPresence`, `addNote`). Wipe calls a local `purge()` that resets the `RtcFeed`, the prefix arrays, and the notes/presence arrays, then persists the emptied session. No changes to the MAIN-world script or the bridge; no new background message. An empty session already produces no file (`finalizeSession`).

**Tech Stack:** TypeScript, esbuild, vitest. Chrome MV3 content script.

**Spec:** `docs/superpowers/specs/2026-07-19-recording-toggle-purge-design.md`

**Note on testing scope:** The spec floated a pure `shouldRecord(recording, eventType)` helper. Dropped deliberately - it would return its own boolean argument, a fake abstraction (the gates are one-line guards). The one genuinely testable unit is `RtcFeed.reset()`, which is TDD'd in Task 2. UI/`meet.ts` are DOM glue with no existing unit coverage; they are verified by typecheck + build + the manual load checklist in Task 6, matching the codebase's existing convention.

---

### Task 1: Persist the recording flag on the session type

**Files:**
- Modify: `src/shared/types.ts` (the `ActiveSession` interface, ends ~line 100)

- [ ] **Step 1: Add the field to `ActiveSession`**

In `src/shared/types.ts`, inside `export interface ActiveSession { ... }`, add after the `captionLanguage?: string` line:

```typescript
  /**
   * Whether capture is currently recording. Absent/undefined means recording
   * (default true) so existing and legacy sessions are unaffected. Persisted so a
   * mid-meeting page reload (reload-resume) restores an Off state instead of
   * silently starting to record again.
   */
  recording?: boolean
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add recording flag to ActiveSession"
```

---

### Task 2: `RtcFeed.reset()`

**Files:**
- Modify: `src/content/meet-rtc/feed.ts` (the `RtcFeed` class)
- Test: `tests/feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/feed.test.ts` (inside the top-level `describe`, or add a new `describe("reset", ...)`). It captures a caption and a chat message, asserts the snapshots are populated, resets, asserts they are empty, then confirms the roster survives (a new caption from a known device still resolves its name):

```typescript
describe("RtcFeed.reset", () => {
  const AT = "2026-07-29T10:00:00.000Z"
  const AT2 = "2026-07-29T10:00:05.000Z"

  it("clears captured transcript, chat and versions but keeps the roster", () => {
    const roster = new Map<string, string>([["dev-1", "Grace Hopper"]])
    const feed = new RtcFeed(roster)

    feed.handleCaption(
      { type: "transcript", deviceId: "dev-1", messageId: 1, messageVersion: 1, text: "hello world" },
      AT,
    )
    feed.handleChat({ type: "chat", deviceId: "dev-1", text: "hi in chat", sender: "Grace Hopper" }, AT)

    expect(feed.transcriptSnapshot().length).toBeGreaterThan(0)
    expect(feed.chatSnapshot().length).toBeGreaterThan(0)
    expect(feed.versionsSnapshot().length).toBeGreaterThan(0)

    feed.reset()

    expect(feed.transcriptSnapshot()).toEqual([])
    expect(feed.chatSnapshot()).toEqual([])
    expect(feed.versionsSnapshot()).toEqual([])

    // Roster retained: a fresh caption from the same device still resolves its name.
    feed.handleCaption(
      { type: "transcript", deviceId: "dev-1", messageId: 2, messageVersion: 1, text: "after reset" },
      AT2,
    )
    const after = feed.transcriptSnapshot()
    expect(after).toHaveLength(1)
    expect(after[0].speaker).toBe("Grace Hopper")
    expect(after[0].text).toBe("after reset")
  })
})
```

If `tests/feed.test.ts` does not already import `RtcFeed`, add at the top:

```typescript
import { RtcFeed } from "../src/content/meet-rtc/feed"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/feed.test.ts -t "reset"`
Expected: FAIL - `feed.reset is not a function`.

- [ ] **Step 3: Implement `reset()`**

In `src/content/meet-rtc/feed.ts`, add a method to the `RtcFeed` class (e.g. right after the constructor). It re-instantiates the `ChatLog` (which has no clear method of its own) and clears the caption/dedup state, but leaves `this.roster` untouched:

```typescript
  /**
   * Wipe all captured content (transcript, chat, and their dedup/order state) so
   * capture restarts from an empty base. The roster (deviceId -> name) is KEPT: it
   * is identity, not content, and turns captured after a wipe still need it to
   * resolve speaker names.
   */
  reset(): void {
    this.captions.clear()
    this.nextOrder = 0
    this.lastEventDeviceId = ""
    this.chat = new ChatLog()
    this.lastSelfChatAt.clear()
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/feed.test.ts -t "reset"`
Expected: PASS.

- [ ] **Step 5: Run the full feed suite to confirm no regression**

Run: `npx vitest run tests/feed.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/content/meet-rtc/feed.ts tests/feed.test.ts
git commit -m "feat(feed): add RtcFeed.reset() to wipe captured content"
```

---

### Task 3: Recording toggle + Wipe controls in the pill group

**Files:**
- Modify: `src/content/core/ui.ts` (`mountMeetingControls`, the `opts` type ~line 135, the pill construction ~line 200-247, and the return object ~line 249)

No unit test (DOM glue, no existing coverage for this file); verified by build + Task 6 manual checklist.

- [ ] **Step 1: Extend the `mountMeetingControls` options and return type**

Change the signature. Add three inputs and keep the existing ones:

```typescript
export function mountMeetingControls(opts: {
  initialLanguage: string
  initialPrivate: boolean
  initialRecording: boolean
  onLanguageChange: (language: string) => void
  onPrivateChange: (isPrivate: boolean) => void
  onRecordingChange: (recording: boolean) => void
  onToggleTranscript: () => void
  onPurge: () => void
}): { unmount: () => void; setTranscriptActive: (active: boolean) => void; setLanguage: (language: string) => void } {
```

- [ ] **Step 2: Build the recording pill**

Insert this block just before the `container.append(...)` line (~line 247), after the privacy pill. On = normal dark pill with a red dot ("● Rec"); Off = amber-filled pill ("⏸ Rec off") so the not-recording state is loud:

```typescript
  // --- recording pill: On shows a red dot on the default dark pill; Off fills the
  // pill amber and reads "Rec off", so a stopped recording is impossible to miss
  // (a silent Off is worse than no feature). Toggling flips the flag via onRecordingChange. ---
  const RECORDING_BG_OFF = "rgba(249,171,0,.95)" // amber fill when NOT recording
  let recording = opts.initialRecording
  const recordingPill = document.createElement("button")
  recordingPill.type = "button"
  recordingPill.style.cssText = PILL_BASE
  recordingPill.title = "Plática Notes: pause/resume capturing this meeting"
  const renderRecording = () => {
    recordingPill.textContent = recording ? "● Rec" : "⏸ Rec off"
    recordingPill.style.background = recording ? PILL_BG : RECORDING_BG_OFF
  }
  recordingPill.addEventListener("mouseenter", () => {
    if (recording) recordingPill.style.background = PILL_BG_HOVER
  })
  recordingPill.addEventListener("mouseleave", renderRecording)
  recordingPill.addEventListener("click", () => {
    recording = !recording
    renderRecording()
    opts.onRecordingChange(recording)
  })
  renderRecording()
```

- [ ] **Step 3: Build the Wipe pill with a two-click confirm**

Insert right after the recording pill block. First click arms a red "Wipe? confirm" state for 4s; a second click within the window fires `onPurge`; otherwise it reverts. All text via `textContent` (XSS-safe), no `confirm()` dialog:

```typescript
  // --- wipe pill: destructive clean-slate for the current meeting. Two-click
  // confirm inline (no native dialog): first click arms for 4s, second click within
  // the window fires onPurge. Reverts on timeout. ---
  const WIPE_BG_ARMED = "rgba(217,48,37,.95)" // red while armed
  let wipeArmed = false
  let wipeTimer: ReturnType<typeof setTimeout> | undefined
  const wipePill = document.createElement("button")
  wipePill.type = "button"
  wipePill.style.cssText = PILL_BASE
  wipePill.title = "Plática Notes: wipe everything captured in this meeting so far"
  const disarmWipe = () => {
    wipeArmed = false
    if (wipeTimer) clearTimeout(wipeTimer)
    wipeTimer = undefined
    wipePill.textContent = "🗑 Wipe"
    wipePill.style.background = PILL_BG
  }
  wipePill.addEventListener("mouseenter", () => {
    if (!wipeArmed) wipePill.style.background = PILL_BG_HOVER
  })
  wipePill.addEventListener("mouseleave", () => {
    if (!wipeArmed) wipePill.style.background = PILL_BG
  })
  wipePill.addEventListener("click", () => {
    if (!wipeArmed) {
      wipeArmed = true
      wipePill.textContent = "🗑 Wipe? confirm"
      wipePill.style.background = WIPE_BG_ARMED
      wipeTimer = setTimeout(disarmWipe, 4000)
      return
    }
    disarmWipe()
    opts.onPurge()
  })
  wipePill.textContent = "🗑 Wipe"
```

- [ ] **Step 4: Append both pills to the container**

Change the existing append line (~line 247) from:

```typescript
  container.append(langPill, transcriptPill, privacyPill)
```

to:

```typescript
  container.append(langPill, transcriptPill, recordingPill, wipePill, privacyPill)
```

- [ ] **Step 5: Verify build + typecheck**

Run: `npm run typecheck && npm run build`
Expected: PASS. (Callers break typecheck until Task 4 supplies the new opts - so run typecheck AFTER Task 4 if it fails here; the build of `ui.ts` itself must compile.)

Note: because `meet.ts` calls `mountMeetingControls` without the new required opts until Task 4, `npm run typecheck` will report errors at the call site. That is expected between Task 3 and Task 4. Proceed to Task 4, then typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/content/core/ui.ts
git commit -m "feat(ui): add recording toggle and Wipe controls to the meeting pill group"
```

---

### Task 4: Gate capture and wire the controls in meet.ts

**Files:**
- Modify: `src/content/platforms/meet.ts` (session init ~line 355, `addNote` ~line 542, `pushPresence` ~line 499, `activeMeetingHandler` ~line 560, `mountMeetingControls` call ~line 459)

No unit test (DOM/session glue); verified by typecheck + build + Task 6.

- [ ] **Step 1: Seed the recording flag from the session**

Find the session object literal (~line 355, where `transcript: prefixTranscript,` etc. are set). Add a `recording` field seeded from the resumed session (default true):

```typescript
    recording: resumed?.recording ?? true,
```

Then, just after the session object is created (before the closures that use it), add a mutable local mirror:

```typescript
  // Live capture gate. Persisted on the session so a reload-resume restores an Off
  // meeting instead of silently recording again.
  let recording = session.recording ?? true
```

- [ ] **Step 2: Gate the transcript/chat handler**

In `activeMeetingHandler` (~line 560), add the guard as the first line of the function body, before the `if (event.type === "transcript")` block:

```typescript
  activeMeetingHandler = (event) => {
    if (!recording && (event.type === "transcript" || event.type === "chat")) return
    if (event.type === "transcript") {
      // ...unchanged...
```

- [ ] **Step 3: Gate presence markers**

At the top of `pushPresence` (~line 499), add:

```typescript
  const pushPresence = (name: string, kind: "join" | "leave"): void => {
    if (!recording) return
    // ...unchanged...
```

- [ ] **Step 4: Gate manual notes with a visible toast**

At the top of `addNote` (~line 542), add the guard + toast so a bookmark/note while Off is a visible no-op, not a silent one:

```typescript
  function addNote(text: string): void {
    if (!recording) {
      showToast("Recording is off")
      return
    }
    // ...unchanged...
```

(`showToast` is already imported at the top of `meet.ts`.)

- [ ] **Step 5: Add the `purge()` closure**

Add this closure in the meeting scope, near `addNote` / `refreshTranscript`. It clears the feed, the prefix arrays (which a reload-resume seeds with pre-reload content), and the notes/presence arrays plus their session mirrors, then persists the emptied session so crash-resume and finalize see it empty:

```typescript
  // Wipe everything captured in THIS meeting so far: the feed, the resumed prefixes,
  // and the notes/presence arrays. Persists the emptied session so a crash-resume or
  // the eventual finalize sees empty -> no file. activeByName (presence bookkeeping)
  // is left intact: it is live identity state, not saved content.
  function purge(): void {
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
    writer.requestWrite()
  }
```

- [ ] **Step 6: Wire the new control callbacks**

Update the `mountMeetingControls({ ... })` call (~line 459) to pass the three new options:

```typescript
  const controls = mountMeetingControls({
    initialLanguage: session.captionLanguage ?? settings.captionLanguage,
    initialPrivate: session.isPrivate,
    initialRecording: recording,
    onPrivateChange: (isPrivate) => {
      session.isPrivate = isPrivate
      writer.requestWrite()
    },
    onRecordingChange: (on) => {
      recording = on
      session.recording = on
      writer.requestWrite()
    },
    onPurge: () => purge(),
    onLanguageChange: (language) => applyLanguage(language),
    onToggleTranscript: () => panel.toggle(),
  })
```

- [ ] **Step 7: Verify typecheck, tests, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS on all three (call site now supplies the new opts).

- [ ] **Step 8: Commit**

```bash
git add src/content/platforms/meet.ts
git commit -m "feat(meet): gate capture behind recording flag and wire Wipe"
```

---

### Task 5: User-facing docs and copy

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Check (grep): `public/popup.html`, `src/pages/**` for any capture-behaviour copy that should mention the toggle

- [ ] **Step 1: Grep for in-app copy that describes capture behaviour**

Run: `grep -rniE "record|capture|privacy|folder" public/ src/pages/ README.md`
Expected: a list of spots. If any user-facing hint describes "records the whole meeting" in a way the toggle now contradicts, note it for Step 2. (Per the project's "sync user-facing descriptions on behavior change" rule.)

- [ ] **Step 2: Add a README section**

Add a short subsection under the features/usage area of `README.md` describing the two controls. Example content:

```markdown
### Recording controls

During a meeting, the Plática Notes pill group offers:

- **● Rec / ⏸ Rec off** - toggle capture on or off for the current meeting.
  Turning it off stops capturing everything new (transcript, chat, join/leave
  markers, and notes); whatever was captured before you turned it off is still
  saved when the meeting ends. The state survives a page reload.
- **🗑 Wipe** - clear everything captured in the current meeting so far
  (transcript, chat, notes, and presence markers). Click once to arm, once more
  to confirm. If nothing remains after a wipe, no file is written.
```

- [ ] **Step 3: Add a CHANGELOG entry**

At the top of `CHANGELOG.md` (newest first), under a new unreleased/next-version heading, add:

```markdown
### Added

- In-meeting **Recording On/Off** toggle - pause and resume capture without
  leaving the call. Off stops all new capture (transcript, chat, presence, notes)
  and persists across a page reload; content captured before Off is still saved.
- In-meeting **Wipe recording** control (two-click confirm) - clears everything
  captured in the current meeting so far. An empty meeting writes no file.
```

(Match the exact heading style already used in `CHANGELOG.md` - inspect the top of the file first and mirror it; do not hand-edit the version number, `npm run release` sets it.)

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document recording toggle and Wipe controls"
```

---

### Task 6: Full verification and manual load check

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests green, `dist/` built.

- [ ] **Step 2: Load the unpacked extension and drive it**

Load `dist/` at `chrome://extensions` (reload it). Join a Meet test call and verify each:

- [ ] The pill group shows **● Rec** (dark) by default.
- [ ] Speak / send a chat line -> it appears in the transcript panel.
- [ ] Click the recording pill -> it turns amber **⏸ Rec off**. Speak and send chat -> nothing new is added to the panel. A join/leave by another participant adds no marker. Pressing Alt+Shift+B (or a panel note) shows a "Recording is off" toast and adds nothing.
- [ ] Click it again -> back to **● Rec**; new speech is captured again (as a fresh turn, not stitched to the pre-Off text).
- [ ] End the meeting while Off -> the saved file contains everything captured **before** Off, and nothing from the Off stretch.
- [ ] Start a fresh call, capture a couple of lines, click **🗑 Wipe** -> it arms ("🗑 Wipe? confirm", red). Click again -> the panel empties. End the meeting immediately -> **no file** is written.
- [ ] Turn recording Off, then reload the Meet tab (reload-resume) -> the pill comes back showing **⏸ Rec off** and capture stays off.
- [ ] Confirm the Meet native Live Caption panel behaviour is unchanged (Off does not touch the captions subscription).

- [ ] **Step 3: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide merge/PR. (Release + Web Store packaging follow the project's normal release flow in `CLAUDE.md`, not this plan.)

---
```
