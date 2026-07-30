# Platform Adapter Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Meet-only capture stack into a platform-neutral core plus thin per-platform adapters, and prove the seam with a minimal Zoom skeleton.

**Architecture:** MAIN-world capture scripts normalise each platform's wire data into one canonical event (`speakerId` / `utteranceId` / `revision` / cumulative `text`). A platform-neutral `session-runner` owns the whole session lifecycle and consumes a `PlatformAdapter` that supplies join/leave detection, the title, the meeting key and the event stream. Capability flags declare what a platform cannot do; a health status says why capture is producing nothing.

**Tech Stack:** TypeScript, esbuild (`build.mjs`), vitest, Chrome MV3. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-platform-adapter-contract-design.md`

**Branch:** `feat/platform-adapter-contract` (already created).

---

## Ground rules for every task

- `npm run typecheck` and `npm test` both clean before every commit. Baseline is **398 passing tests**; tasks 1-5 must not change that count except where this plan says a test file is split or extended.
- Tasks 1-5 are **behaviour preserving**. If Meet behaviour changes, it is a bug in the move, not an improvement.
- Never introduce `fetch` / `XHR` / `sendBeacon` / `WebSocket`, and never put an untrusted string into the DOM other than via `textContent`. Both are product invariants (see `CLAUDE.md`).
- Fixtures use fictional names (Grace Hopper, Ada Lovelace) and `abc-defg-hij`.
- Conventional commits. One commit per task unless a task says otherwise.

---

## File structure after the plan

```
src/content/
  capture/
    protocol.ts              canonical events + CustomEvent names (was meet-rtc/bridge.ts)
    meet/                    was meet-rtc/ minus feed.ts
      main.ts  proto.ts  identity.ts  build-probe.ts  lifecycle.ts
    zoom/
      main.ts                Redux interception (MAIN world)
      map.ts                 Redux action -> canonical event (pure)
  core/
    feed.ts                  was meet-rtc/feed.ts, now rules-driven
    session-runner.ts        NEW: the session lifecycle, was runMeeting()
    session-lifecycle.ts     NEW: platform-neutral pure helpers
    health.ts                NEW: capture health state machine
    collector.ts  persistence.ts  ui.ts  transcript-panel.ts  hotkeys.ts   (unchanged)
  platforms/
    adapter.ts               NEW: PlatformAdapter, Capabilities
    meet.ts                  Meet specifics only
    meet-lifecycle.ts        Meet-specific pure helpers + MEET_CAPTION_RULES
    zoom.ts                  NEW: the skeleton
tests/
  capture-protocol.test.ts   NEW   session-runner.test.ts  NEW
  session-lifecycle.test.ts  NEW   health.test.ts          NEW
  zoom-map.test.ts           NEW
  (existing files keep their names; feed.test.ts and meet-lifecycle.test.ts are edited)
```

---

## Task 1: Canonical protocol and the capture/ move

**Files:**
- Move: `src/content/meet-rtc/` → `src/content/capture/meet/` (all seven files)
- Move: `src/content/capture/meet/bridge.ts` → `src/content/capture/protocol.ts`
- Modify: `src/content/capture/meet/main.ts` (dispatch sites), `src/content/capture/meet/feed.ts`, `src/content/platforms/meet.ts` (imports + event field names)
- Modify: `tests/feed.test.ts`, `tests/proto.test.ts`, `tests/identity.test.ts`, `tests/build-probe.test.ts`, `tests/lifecycle.test.ts` (import paths; feed field names)
- Modify: `build.mjs`, `public/manifest.json`, `scripts/screenshots.mjs`

This task is atomic: the rename cannot be half-applied and stay green.

- [ ] **Step 1: Move the directory**

```bash
mkdir -p src/content/capture
git mv src/content/meet-rtc src/content/capture/meet
git mv src/content/capture/meet/bridge.ts src/content/capture/protocol.ts
```

- [ ] **Step 2: Rewrite `src/content/capture/protocol.ts`**

Keep the three `CustomEvent` names byte-identical (`scripts/screenshots.mjs` and the
MAIN-world bundle both depend on them). Replace the `Rtc*` types with the canonical
ones. Note `RosterEvent` / `RosterLeaveEvent` naming: `ParticipantEvent` is already
taken by `src/shared/types.ts` (the saved join/leave marker) and must not be shadowed.

```ts
// Shared contract between a MAIN-world capture script (capture/<platform>/main.ts)
// and its isolated-world adapter. Imported by both bundles — esbuild bundles each
// entry separately, so the constants are duplicated into each output.

// CustomEvent name dispatched by the MAIN-world script on `document`.
// `detail` is a JSON STRING of CaptureEvent: plain objects do NOT cross Chrome's
// isolated-world boundary (each world has its own JS heap, and non-primitive
// detail values arrive as null on the other side), so we serialize.
export const RTC_EVENT = "platica-rtc"

// CustomEvent name dispatched by the isolated-world adapter on `document`.
// `detail` is a JSON string of CaptureConfig (same boundary constraint).
export const RTC_CONFIG_EVENT = "platica-rtc-config"

// MAIN-world script dispatches these (detail = JSON string of a DebugEvent with
// ctx:"rtc") only when debug is enabled; the isolated adapter collects them.
export const RTC_DEBUG_EVENT = "platica-rtc-debug"

/**
 * One revision of a spoken turn.
 *
 * TWO INVARIANTS EVERY PLATFORM MUST HONOUR, because the core loses text silently
 * if either is broken:
 *
 * 1. `text` is the CUMULATIVE text of this utterance so far, never a delta. The
 *    feed strips the already-emitted prefix itself (see suffixAfter).
 * 2. `revision` strictly increases within one `utteranceId`. The feed drops any
 *    revision <= the one it already holds. Meet reads it off the wire; a platform
 *    without a version field (Zoom) must keep its own per-utterance counter.
 *    Do NOT use Date.now() for this: two revisions inside one millisecond would
 *    collide and the second would be dropped.
 *
 * Events for one channel are emitted in arrival order, but consumers must still
 * treat max(revision) per (speakerId, utteranceId) as the winner.
 */
export interface UtteranceEvent {
  type: "utterance"
  speakerId: string
  utteranceId: string
  revision: number
  text: string
}

// No timestamp here: a platform's wire timestamp unit is rarely verifiable, so the
// adapter stamps receive time instead of trusting the wire value.
// `sender` is the display name embedded in the chat packet, when the platform ships
// one; optional because Meet's live diagnostic logger truncates packets before it.
export interface ChatEvent {
  type: "chat"
  speakerId: string
  text: string
  sender?: string
  // Stable platform message id, when there is one (Meet: the "spaces/…/messages/…"
  // resource name). The feed dedupes on it, because a re-syncing channel can deliver
  // the same message more than once. Absent for messages without an id.
  messageId?: string
}

export interface RosterEvent {
  type: "roster"
  speakerId: string
  name: string
}

// A participant left: the platform removed their roster entry. `name` is present
// when the removal packet still carries it, which lets the adapter resolve the name
// even for a speaker it never saw arrive.
export interface RosterLeaveEvent {
  type: "roster-leave"
  speakerId: string
  name?: string
}

// The local user's own display name. Meet never rosters self, so the adapter binds
// this to otherwise-unresolved speakers.
export interface SelfEvent {
  type: "self"
  name: string
}

// Liveness of the call's media path: the count of open media-session data channels
// (one per peer connection) after the latest open/close, plus that connection's
// state. Carries no content. An adapter that declares capabilities.livenessEnd
// treats a sustained zero as the authoritative meeting-end signal.
export interface LivenessEvent {
  type: "liveness"
  openSessions: number
  pcState: RTCPeerConnectionState
}

export type CaptureEvent =
  | UtteranceEvent
  | ChatEvent
  | RosterEvent
  | RosterLeaveEvent
  | SelfEvent
  | LivenessEvent

export interface CaptureConfig {
  captionLanguage: string
  debug: boolean
}
```

- [ ] **Step 3: Map Meet's vocabulary to the canonical events in `capture/meet/main.ts`**

Meet's own words (`deviceId`, `messageId`, `messageVersion`) stay inside
`capture/meet/*` — that is the vocabulary of Meet's wire and its protobuf decoder.
Only the `dispatch(...)` call sites translate. Apply exactly these edits:

| Line (pre-edit) | Before | After |
| --- | --- | --- |
| 22 | `from "./bridge"` | `from "../protocol"` |
| 129 | `function dispatch(event: RtcEvent)` | `function dispatch(event: CaptureEvent)` |
| 142 | `{ type: "media", openSessions: sessions.length, pcState: pc.connectionState }` | `{ type: "liveness", openSessions: sessions.length, pcState: pc.connectionState }` |
| 344-350 | `{ type: "transcript", deviceId: m.deviceId, messageId: m.messageId, messageVersion: m.messageVersion, text: m.text }` | `{ type: "utterance", speakerId: m.deviceId, utteranceId: String(m.messageId), revision: m.messageVersion, text: m.text }` |
| 372-378 | `{ type: "chat", deviceId: p.deviceId, text: p.text, …sender, …messageId }` | `{ type: "chat", speakerId: p.deviceId, text: p.text, …sender, …messageId }` (spread guards unchanged) |
| 408 | `{ type: "device-leave", deviceId: entry.deviceId, deviceName: entry.deviceName }` | `{ type: "roster-leave", speakerId: entry.deviceId, name: entry.deviceName }` |
| 412 | `{ type: "device", deviceId: entry.deviceId, deviceName: entry.deviceName }` | `{ type: "roster", speakerId: entry.deviceId, name: entry.deviceName }` |
| 424 | `{ type: "device-leave", deviceId }` | `{ type: "roster-leave", speakerId: deviceId }` |
| 598-… | second `{ type: "chat", deviceId: … }` (meet_messages self-send path) | `speakerId:` |
| 680 | `{ type: "self", name }` | unchanged |
| 698, 717 | `{ type: "device", deviceId: …, deviceName: … }` | `{ type: "roster", speakerId: …, name: … }` |

Also rename the imported config type: `RtcConfig` → `CaptureConfig` at its use site.
Leave every `record({ phase: … })` diagnostic exactly as it is — the debug log's field
names are an operational contract with the logs already collected.

- [ ] **Step 4: Update the feed to the canonical fields**

In `src/content/capture/meet/feed.ts` (it moves to core in Task 2 — do not move it
here): change the import to `../protocol`, the parameter types to
`UtteranceEvent` / `ChatEvent`, and inside `handleCaption`:

```ts
  handleCaption(ev: UtteranceEvent, at: string): boolean {
    const key = `${ev.speakerId}/${ev.utteranceId}`
```
with `ev.messageVersion` → `ev.revision`, `ev.deviceId` → `ev.speakerId` throughout
(including `handleChat` and the `lastEventDeviceId` comparisons). Rename the private
field `lastEventDeviceId` → `lastEventSpeakerId` and `speakerFor(deviceId)` →
`speakerFor(speakerId)`; keep the `spaces/<id>/devices/<n>` tail fallback as-is for now
(Task 2 turns it into a rule).

- [ ] **Step 5: Update the isolated adapter**

In `src/content/platforms/meet.ts`: imports move from `../meet-rtc/bridge` to
`../capture/protocol` and from `../meet-rtc/feed` to `../capture/meet/feed`. Rename in
place: `RtcCaptionEvent` → `UtteranceEvent`, `RtcChatEvent` → `ChatEvent`, `RtcEvent` →
`CaptureEvent`. In the page-level router (`main()`, lines 180-213) rename the branches:
`"device"` → `"roster"`, `"device-leave"` → `"roster-leave"`, `"media"` → `"liveness"`,
and read `parsed.speakerId` / `parsed.name` instead of `parsed.deviceId` /
`parsed.deviceName`. In `activeMeetingHandler` (line 596) the branch `"transcript"`
becomes `"utterance"`. In the `chat.google.com` postMessage handler (line 233) the
synthesised event becomes `{ type: "chat", speakerId: "self", … }`.

- [ ] **Step 6: Update the tests**

```bash
grep -rln "meet-rtc" tests/
```
Fix those import paths (`../src/content/capture/meet/…`, `../src/content/capture/protocol`).
In `tests/feed.test.ts` rename the event fields in every fixture: `deviceId:` →
`speakerId:`, `messageId: <n>` → `utteranceId: "<n>"` (string literals — the ids are
now strings), `messageVersion:` → `revision:`, `type: "transcript"` → `type: "utterance"`.
Chat fixtures keep `messageId` (that field survives) but rename `deviceId` → `speakerId`.

- [ ] **Step 7: Update the build, the manifest and the screenshot harness**

`build.mjs` entry points:

```js
  entryPoints: {
    background: "src/background/index.ts",
    "content-meet": "src/content/platforms/meet.ts",
    "capture-meet": "src/content/capture/meet/main.ts",
    "chatgoogle-main": "src/content/chatgoogle/main.ts",
    popup: "src/pages/popup/popup.ts",
    options: "src/pages/options/options.ts",
    history: "src/pages/history/history.ts",
    welcome: "src/pages/welcome/welcome.ts",
  },
```

`public/manifest.json`: the first Meet content script's `js` becomes
`["capture-meet.js"]`.

`scripts/screenshots.mjs`: the fixture feeder at lines 283-314 emits the old shapes.
Update to the canonical ones — `{ type: "roster", speakerId, name }`,
`{ type: "roster-leave", speakerId, name }`, `{ type: "chat", speakerId, … }`, and for
transcript `{ type: "utterance", speakerId, utteranceId: String(id), revision: version + 1, text }`.
Rename the loop locals from `deviceId`/`deviceName` to `speakerId`/`name` so the file
reads consistently.

- [ ] **Step 8: Verify**

```bash
npm run typecheck && npm test
```
Expected: typecheck clean, 398 tests passing.

```bash
npm run build && npm run screenshots
```
Expected: `dist/` builds, five PNGs regenerate in `docs/store/screenshots/`. If a
screenshot comes out empty, the fixture shapes in step 7 do not match the protocol —
fix there, not in the extension.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(capture): canonical capture protocol, meet-rtc becomes capture/meet

Neutral event shape (speakerId/utteranceId/revision/cumulative text) so a second
platform can feed the same core. Meet's own vocabulary stays inside capture/meet;
only the dispatch sites translate. No behaviour change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Feed moves to core and becomes rules-driven

**Files:**
- Move: `src/content/capture/meet/feed.ts` → `src/content/core/feed.ts`
- Modify: `src/content/platforms/meet-lifecycle.ts` (add `MEET_CAPTION_RULES`)
- Modify: `src/content/platforms/meet.ts` (construct the feed with rules)
- Test: `tests/feed.test.ts` (import path, new rules cases)

`MEET_CAPTION_RULES` lives in `meet-lifecycle.ts` rather than `meet.ts` because
`meet.ts` calls `main()` at import time and cannot be imported from a test.

- [ ] **Step 1: Move the file and rename the class**

```bash
git mv src/content/capture/meet/feed.ts src/content/core/feed.ts
```
Rename `RtcFeed` → `CaptureFeed` in `src/content/core/feed.ts`,
`src/content/platforms/meet.ts` and `tests/feed.test.ts`. Fix the import of `ChatLog`
(now `./collector`) and of the protocol (`../capture/protocol`).

- [ ] **Step 2: Write the failing tests for the rules**

Append to `tests/feed.test.ts`:

```ts
import { CaptureFeed, type CaptionRules } from "../src/content/core/feed"

const NO_SPLIT_RULES: CaptionRules = {
  interruptionGapMs: null,
  speakerLabel: (id) => `Guest ${id}`,
  selfChatDedupMs: null,
}

describe("caption rules", () => {
  it("never splits a turn when interruptionGapMs is null", () => {
    const feed = new CaptureFeed(new Map(), NO_SPLIT_RULES)
    feed.handleCaption({ type: "utterance", speakerId: "a", utteranceId: "1", revision: 1, text: "hello" }, "2026-07-30T10:00:00.000Z")
    feed.handleCaption({ type: "utterance", speakerId: "b", utteranceId: "2", revision: 1, text: "sorry" }, "2026-07-30T10:00:01.000Z")
    feed.handleCaption({ type: "utterance", speakerId: "a", utteranceId: "1", revision: 2, text: "hello there" }, "2026-07-30T10:00:05.000Z")
    const turns = feed.transcriptSnapshot().filter((t) => t.speaker === "Guest a")
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe("hello there")
  })

  it("uses the rule's label for a speaker the roster does not know", () => {
    const feed = new CaptureFeed(new Map(), NO_SPLIT_RULES)
    feed.handleCaption({ type: "utterance", speakerId: "zz", utteranceId: "1", revision: 1, text: "hi" }, "2026-07-30T10:00:00.000Z")
    expect(feed.transcriptSnapshot()[0].speaker).toBe("Guest zz")
  })

  it("keeps both self-chat copies when selfChatDedupMs is null", () => {
    const feed = new CaptureFeed(new Map(), NO_SPLIT_RULES)
    feed.handleChat({ type: "chat", speakerId: "self", text: "ping", messageId: "self-out/1" }, "2026-07-30T10:00:00.000Z")
    feed.handleChat({ type: "chat", speakerId: "self", text: "ping", messageId: "self-topic/1" }, "2026-07-30T10:00:00.500Z")
    expect(feed.chatSnapshot()).toHaveLength(2)
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

```bash
npx vitest run tests/feed.test.ts
```
Expected: FAIL — `CaptureFeed` takes one argument, `CaptionRules` is not exported.

- [ ] **Step 4: Implement the rules in `src/content/core/feed.ts`**

Replace the two module constants with a rules object. Delete
`const INTERRUPTION_GAP_MS = 1000` and `const SELF_CHAT_DEDUP_MS = 5000`, keeping their
comments on the interface fields:

```ts
/**
 * The three behaviours that genuinely differ between meeting platforms. Everything
 * else in this file is platform-neutral.
 */
export interface CaptionRules {
  /**
   * Meet keeps ONE utteranceId growing even after another speaker interjects, so a
   * single id can span an interruption; anchoring all of its text at the first-seen
   * time sorts the later words back before the interrupter and breaks chronology.
   * When set, an id is split into a new block once another speaker spoke AND this
   * utterance had gone quiet for at least this long. `null` means the platform
   * starts a fresh id per turn, so splitting would only fragment it.
   */
  interruptionGapMs: number | null
  /** Label for a speaker the roster cannot name yet. */
  speakerLabel: (speakerId: string) => string
  /**
   * Window for collapsing the SAME own-chat send arriving on two transports with
   * different ids (Meet: the meet_messages hook and the chat.google.com frame).
   * `null` for a platform with a single own-chat transport.
   */
  selfChatDedupMs: number | null
}
```

Constructor:

```ts
  constructor(
    roster: Map<string, string> = new Map(),
    private readonly rules: CaptionRules,
  ) {
    this.roster = roster
  }
```

In `handleCaption`, the split decision becomes:

```ts
      const gap = this.rules.interruptionGapMs
      const otherSpoke = this.lastEventSpeakerId !== "" && this.lastEventSpeakerId !== ev.speakerId
      const shouldSplit = gap !== null && otherSpoke && elapsedMs(existing.lastAt, at) >= gap
```

In `handleChat`, guard the self dedup:

```ts
    const selfWindow = this.rules.selfChatDedupMs
    if (selfWindow !== null && isSelfChatId(ev.messageId)) {
      // …existing body, using selfWindow instead of SELF_CHAT_DEDUP_MS
    }
```

In `speakerFor`, the fallback becomes `return this.rules.speakerLabel(speakerId)`.

- [ ] **Step 5: Add the Meet rules**

Append to `src/content/platforms/meet-lifecycle.ts`:

```ts
import type { CaptionRules } from "../core/feed"

// Meet's caption semantics, measured on live meetings:
//  - one messageId survives another speaker's interjection (hence a split rule);
//  - device ids look like spaces/<id>/devices/<n>, and the tail is short and stable
//    enough to tell speakers apart until the roster names them;
//  - own chat arrives on two transports (meet_messages hook + chat.google.com frame).
export const MEET_CAPTION_RULES: CaptionRules = {
  interruptionGapMs: 1000,
  speakerLabel: (speakerId) => `Speaker ${speakerId.slice(speakerId.lastIndexOf("/") + 1) || speakerId}`,
  selfChatDedupMs: 5000,
}
```

In `src/content/platforms/meet.ts` line ~379: `const feed = new CaptureFeed(roster, MEET_CAPTION_RULES)`.

- [ ] **Step 6: Point the existing feed tests at the Meet rules**

The suite's existing expectations (`Speaker 3`, the interruption split, the self-chat
collapse) encode Meet behaviour, so they must construct the feed with
`MEET_CAPTION_RULES`. At the top of `tests/feed.test.ts`:

```ts
import { MEET_CAPTION_RULES } from "../src/content/platforms/meet-lifecycle"
```
and replace every `new CaptureFeed(` that passed only a roster (or nothing) with
`new CaptureFeed(roster ?? new Map(), MEET_CAPTION_RULES)`.

- [ ] **Step 7: Verify**

```bash
npm run typecheck && npm test
```
Expected: typecheck clean, 401 tests passing (398 + the three new rules cases).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(core): feed moves to core and takes per-platform caption rules

Splitting on interruption, the unresolved-speaker label and the two-transport
own-chat dedup are Meet semantics, not universal ones. They become data
(CaptionRules) so a platform that starts a fresh utterance id per turn does not
inherit Meet's split heuristics.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Split the pure lifecycle helpers

**Files:**
- Create: `src/content/core/session-lifecycle.ts`
- Modify: `src/content/platforms/meet-lifecycle.ts`, `src/content/platforms/meet.ts`
- Create: `tests/session-lifecycle.test.ts`
- Modify: `tests/meet-lifecycle.test.ts`

Neutral (move): `seedAttendees`, `isMidMeetingJoin`, `shouldAskLanguage`,
`shouldFinalizeStaleSession`. Meet-specific (stay): `shouldDrainTail`,
`shouldFinishRearmWait`, `nextLeaveState`, `nextMediaZeroSince`, `shouldEndFromMedia`,
`LeaveState`, `MEET_CAPTION_RULES`.

`nextMediaZeroSince` / `shouldEndFromMedia` stay Meet-side deliberately: they belong to
the adapter that declares `livenessEnd`, and a platform without a media signal must not
inherit a helper implying it has one.

- [ ] **Step 1: Create the core module**

Move the four functions with their full comment blocks verbatim into
`src/content/core/session-lifecycle.ts`, prefixed with:

```ts
// Platform-neutral pure decisions used by the session runner. No DOM, no chrome.*,
// no timers — every input is passed in, so the whole file is unit-testable.
```
Delete them from `meet-lifecycle.ts` and update its header comment to say it holds the
Meet-specific decisions only.

- [ ] **Step 2: Update the importers**

`src/content/platforms/meet.ts` splits its `./meet-lifecycle` import: the four moved
names come from `../core/session-lifecycle`.

- [ ] **Step 3: Split the tests**

Create `tests/session-lifecycle.test.ts` and move the `describe` blocks for
`seedAttendees`, `isMidMeetingJoin`, `shouldAskLanguage` and
`shouldFinalizeStaleSession` into it verbatim, with the import pointed at
`../src/content/core/session-lifecycle`. Leave the rest in
`tests/meet-lifecycle.test.ts`.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm test
```
Expected: typecheck clean, 401 tests passing (the same tests, in two files).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(core): split platform-neutral lifecycle decisions out of meet-lifecycle

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The adapter interface, implemented by Meet

**Files:**
- Create: `src/content/platforms/adapter.ts`
- Modify: `src/content/platforms/meet.ts`
- Test: `tests/capture-protocol.test.ts` (new)

The interface must exist before the runner can take it. In this task Meet **assembles**
the adapter object out of code it already has; `main()`/`runMeeting()` still drive
everything. No behaviour change.

- [ ] **Step 1: Write `src/content/platforms/adapter.ts`**

```ts
import type { PlatformId } from "../../shared/types"
import type { ActiveSession } from "../../shared/types"
import type { CaptureEvent } from "../capture/protocol"
import type { CaptionRules } from "../core/feed"

/**
 * What a platform can and cannot do. Declared rather than discovered, so the UI can
 * hide a control instead of offering one that silently does nothing, and so a saved
 * file never implies a feature was on when the platform cannot supply it.
 */
export interface Capabilities {
  /** In-meeting chat is captured. */
  chat: boolean
  /**
   * Caption language control. "self": we can switch it ourselves (Meet subscribes
   * its own captions channel). "host-only": the platform gates it behind the
   * host/organiser role, so a switch can fail for reasons outside our control.
   * "none": no control at all; the language pill does not mount.
   */
  languageSwitch: "self" | "host-only" | "none"
  /** Per-utterance revision history is available (the ASR alternatives feature). */
  rawVersions: boolean
  /** Join/leave markers can be derived from the platform's roster. */
  participantEvents: boolean
  /** The end of a call is confirmed by a liveness signal, not only by the DOM. */
  livenessEnd: boolean
}

/**
 * Everything platform-specific the session runner needs. One implementation per
 * meeting platform; the runner holds no platform knowledge at all.
 */
export interface PlatformAdapter {
  readonly id: PlatformId
  readonly capabilities: Capabilities
  readonly captionRules: CaptionRules

  /** Is the current URL a meeting page of this platform? */
  isMeetingPage(): boolean
  /**
   * Stable key identifying THIS meeting within the platform (Meet: the pathname,
   * Zoom: the meeting id). Used for reload-resume matching and rejoin pacing.
   * Null when not on a meeting page.
   */
  meetingKey(): string | null
  /**
   * Resolve once the user is actually in the call. `abort` is polled; return false
   * if it fired (the user backed out of the lobby) so the runner does not start.
   */
  waitForJoin(abort: () => boolean): Promise<boolean>
  /** Start watching for the end of the call. Returns a teardown function. */
  watchEnd(onEnd: (reason: string) => void): () => void
  /** Human-readable meeting title, or "" to let the runner fall back to document.title. */
  readTitle(): string
  /** Join link for the saved file's front matter, or undefined if none can be built. */
  meetingUrl(key: string): string | undefined
  /** Subscribe to this platform's canonical capture events. Returns an unsubscribe. */
  subscribe(on: (event: CaptureEvent) => void): () => void

  /** Switch the caption language. Absent when capabilities.languageSwitch is "none". */
  setLanguage?(tag: string): void
  /**
   * Extra platform fields to stamp into every persisted snapshot (Meet: the
   * chat.google.com conversation URL). Called on every write, so it must be cheap
   * and side-effect free.
   */
  snapshotFields?(): Partial<ActiveSession>
  /** Platform bookkeeping after a meeting is finalized (Meet: arm the tail grace). */
  afterFinalize?(key: string): void
}
```

- [ ] **Step 2: Write the conformance test**

`tests/capture-protocol.test.ts` — this is the test that makes the contract real: a
non-Meet fake adapter drives the shared feed and the invariants are asserted.

```ts
import { describe, expect, it } from "vitest"
import { CaptureFeed, type CaptionRules } from "../src/content/core/feed"
import type { PlatformAdapter } from "../src/content/platforms/adapter"

// A second, deliberately un-Meet-like platform: string utterance ids, an arrival
// counter for revisions, one turn per id, no own-chat double transport.
const FAKE_RULES: CaptionRules = {
  interruptionGapMs: null,
  speakerLabel: (id) => `Speaker ${id}`,
  selfChatDedupMs: null,
}

const fake: PlatformAdapter = {
  id: "zoom",
  capabilities: { chat: false, languageSwitch: "none", rawVersions: true, participantEvents: true, livenessEnd: false },
  captionRules: FAKE_RULES,
  isMeetingPage: () => true,
  meetingKey: () => "123456789",
  waitForJoin: async () => true,
  watchEnd: () => () => {},
  readTitle: () => "Weekly sync",
  meetingUrl: (key) => `https://example.zoom.us/wc/${key}/join`,
  subscribe: () => () => {},
}

describe("capture protocol conformance", () => {
  it("accepts a growing utterance and keeps only the newest revision", () => {
    const feed = new CaptureFeed(new Map([["u1", "Grace Hopper"]]), fake.captionRules)
    expect(feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 1, text: "the compiler" }, "2026-07-30T09:00:00.000Z")).toBe(true)
    expect(feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 2, text: "the compiler works" }, "2026-07-30T09:00:01.000Z")).toBe(true)
    const turns = feed.transcriptSnapshot()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ speaker: "Grace Hopper", text: "the compiler works" })
  })

  it("rejects a stale revision instead of overwriting the text", () => {
    const feed = new CaptureFeed(new Map(), fake.captionRules)
    feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 7, text: "final text" }, "2026-07-30T09:00:00.000Z")
    expect(feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 7, text: "older" }, "2026-07-30T09:00:01.000Z")).toBe(false)
    expect(feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: 6, text: "much older" }, "2026-07-30T09:00:02.000Z")).toBe(false)
    expect(feed.transcriptSnapshot()[0].text).toBe("final text")
  })

  it("treats the same utterance id from two speakers as two turns", () => {
    const feed = new CaptureFeed(new Map(), fake.captionRules)
    feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "1", revision: 1, text: "mine" }, "2026-07-30T09:00:00.000Z")
    feed.handleCaption({ type: "utterance", speakerId: "u2", utteranceId: "1", revision: 1, text: "also mine" }, "2026-07-30T09:00:01.000Z")
    expect(feed.transcriptSnapshot().map((t) => t.text)).toEqual(["mine", "also mine"])
  })

  it("keeps every distinct revision for the alternatives feature", () => {
    const feed = new CaptureFeed(new Map(), fake.captionRules)
    for (const [i, text] of ["a", "a b", "a b c"].entries()) {
      feed.handleCaption({ type: "utterance", speakerId: "u1", utteranceId: "m1", revision: i + 1, text }, "2026-07-30T09:00:00.000Z")
    }
    expect(feed.versionsSnapshot()[0].versions).toEqual(["a", "a b", "a b c"])
  })
})
```

- [ ] **Step 3: Run it**

```bash
npx vitest run tests/capture-protocol.test.ts
```
Expected: FAIL on the import of `adapter.ts` only if step 1 was skipped; otherwise PASS.
These assertions describe the feed's existing behaviour, exercised through a non-Meet
rules profile — a failure here means Task 2 changed Meet semantics by accident.

- [ ] **Step 4: Assemble the Meet adapter**

In `src/content/platforms/meet.ts`, below the existing helpers, add:

```ts
export const meetAdapter: PlatformAdapter = {
  id: "meet",
  capabilities: {
    chat: true,
    languageSwitch: "self",
    rawVersions: true,
    participantEvents: true,
    livenessEnd: true,
  },
  captionRules: MEET_CAPTION_RULES,
  isMeetingPage: () => MEETING_PATH.test(location.pathname),
  meetingKey: () => (MEETING_PATH.test(location.pathname) ? location.pathname : null),
  waitForJoin: async (abort) => !!(await waitForIcon(LEAVE_ICON_TEXT, abort)),
  watchEnd: (onEnd) => watchMeetEnd(onEnd),
  readTitle: () => readMeetingTitle(),
  meetingUrl: (key) => `https://meet.google.com${key}`,
  subscribe: (on) => subscribeMeetEvents(on),
  setLanguage: (tag) => pushRtcConfig(tag, debugEnabled),
  snapshotFields: () => ({ chatUrl: chatUrl ?? undefined }),
  afterFinalize: () => armTailGrace(),
}
```

Then extract three functions from the existing code so the object above compiles,
moving the code verbatim:

- `watchMeetEnd(onEnd)` — the click delegation (`onDocumentClick`, line 629-635) plus
  the `endWatcher` interval (line 647-661) plus the `onMediaState` wiring (line 642-645),
  returning a teardown that clears the interval and removes the listener. It calls
  `onEnd(reason)` where the current code calls `void endMeeting(reason)`.
- `subscribeMeetEvents(on)` — the two `document.addEventListener(RTC_EVENT/…)` blocks
  and the `chat.google.com` `window.addEventListener("message")` block from `main()`
  (lines 158-240), forwarding parsed `CaptureEvent`s to `on`. Keep the field validation
  exactly as it is. Return a teardown that removes all three listeners.
- `armTailGrace()` — sets the module-level `lastMeetingPath` / `lastMeetingEndedAt` that
  the soft-nav loop already uses for `shouldDrainTail`.

`main()` and `runMeeting()` keep calling the same code paths; the adapter object is
additional surface, not yet the driver. `pushRtcConfig` becomes the single place the
language reaches the MAIN world (it already is).

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm test
```
Expected: typecheck clean, 405 tests passing (401 + four conformance cases).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(platforms): define the PlatformAdapter contract and implement it for Meet

The interface plus a conformance test driven by a non-Meet rules profile. Meet
assembles the adapter out of existing code; the runner still drives the old path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Extract the session runner

**Files:**
- Create: `src/content/core/session-runner.ts`
- Modify: `src/content/platforms/meet.ts` (shrinks to platform specifics)
- Create: `tests/session-runner.test.ts`

This is the risky task. `runMeeting()` (`src/content/platforms/meet.ts:286-743`) has
ordering that was paid for in production bugs. Preserve it exactly.

**Ordering invariants that must survive the move** (each one exists because it broke
once):

1. The stale-session finalize happens **before** `waitForJoin` and **before**
   `meetingStarted`, or a different meeting's transcript is overwritten and lost.
2. The transcript is persisted **before** the caption-flush wait, or a post-leave
   reload kills the finalize and the file is never written.
3. The flush wait breaks early once liveness has dropped, instead of sitting the full
   `CAPTION_FLUSH_MS`.
4. Event routing is nulled **after** the flush wait and **before** `meetingEnded`, or a
   late caption re-creates the session key the background just cleared.
5. `writer.close()` after the final `writeNow()`, before `meetingEnded`.
6. `ending` guards `recordDevice` / `recordLeave` so the end-of-call roster teardown
   does not emit a storm of "left" markers.
7. The join-settle window is measured from **this run's** start, not `session.startedAt`
   (a resumed session's start is far in the past).

- [ ] **Step 1: Create the runner with the platform-neutral body**

`src/content/core/session-runner.ts` exports:

```ts
export interface RunnerDeps {
  tabId: number
  adapter: PlatformAdapter
  /** Page-level roster shared across meetings in this tab (speakerId -> name). */
  roster: Map<string, string>
  /** Page-level self name, or null. Returned by reference-free getter/setter. */
  getSelfName: () => string | null
  setSelfName: (name: string) => void
  /** Debug plumbing owned by the platform bundle (its ring buffer and enable flag). */
  debug: {
    enabled: () => boolean
    events: () => DebugEvent[]
    onEvent: (cb: (() => void) | null) => void
    log: (msg: string, extra?: Record<string, unknown>) => void
  }
  onContextInvalidated: () => void
  noteIfInvalidated: (r: BackgroundResponse) => void
}

/** Runs ONE meeting to completion. Resolves when the meeting has been finalized. */
export async function runSession(deps: RunnerDeps): Promise<void>
```

Move lines 286-743 of `meet.ts` into `runSession`, applying exactly these
substitutions:

| In `runMeeting` | In `runSession` |
| --- | --- |
| `location.pathname` (as the meeting key) | `deps.adapter.meetingKey()` (bail if null) |
| `waitForIcon(LEAVE_ICON_TEXT, …)` | `deps.adapter.waitForJoin(() => deps.adapter.meetingKey() !== key)` |
| `readMeetingTitle()` | `deps.adapter.readTitle() || document.title` |
| `platform: "meet"` | `platform: deps.adapter.id` |
| `new CaptureFeed(roster, MEET_CAPTION_RULES)` | `new CaptureFeed(deps.roster, deps.adapter.captionRules)` |
| `selfName` | `deps.getSelfName()` |
| `{ …session, roster: …, selfName: …, chatUrl: … }` (writer snapshot) | `{ ...session, roster: Object.fromEntries(deps.roster), selfName: deps.getSelfName() ?? undefined, ...deps.adapter.snapshotFields?.() }` |
| the module-level hook slots (`activeMeetingHandler`, `recordAttendee`, `recordDevice`, `recordLeave`, `refreshTranscript`, `addNoteToActive`, `onMediaState`) | locals inside `runSession`, wired via the `deps.adapter.subscribe(...)` handler |
| `pushRtcConfig(language, debugEnabled)` | `deps.adapter.setLanguage?.(language)` |
| the click delegation + `endWatcher` + `onMediaState` block | `const stopWatching = deps.adapter.watchEnd((reason) => void endMeeting(reason))` |
| `clearInterval(endWatcher)` / `removeEventListener` in `endMeeting` | `stopWatching()` |
| `mediaZeroSince !== null` (flush early-break) | `livenessDown` — a local the subscribe handler sets from `liveness` events; when `!adapter.capabilities.livenessEnd` it stays false and the flush runs its full window |
| `dlog(...)` | `deps.debug.log(...)` |
| `debugEvents` / `debugStart` / `DEBUG_EVENTS_MAX` | `deps.debug.events()` and the same cap, kept in the runner |

The `roster` / `self` / `roster-leave` handling currently living in `main()`'s
page-level listener moves **into the runner's** subscribe handler: on `roster`, update
`deps.roster`, `recordAttendee(name)`, `recordDevice(speakerId, name)`,
`refreshTranscript()`; on `roster-leave`, keep the name mapping then `recordLeave`; on
`self`, `deps.setSelfName(name)` + `recordAttendee(name)`; on `liveness`, update
`livenessDown` via `nextMediaZeroSince`-equivalent bookkeeping owned by the adapter
(`watchEnd` already makes the decision — the runner only needs the boolean for the
flush early-break).

- [ ] **Step 2: Shrink `meet.ts` to the platform**

What remains in `src/content/platforms/meet.ts`: the DOM-contract block, `MEETING_PATH`,
the Meet constants, the debug ring buffer + `dlog`, `contextInvalidated` handling,
`pushRtcConfig`, `watchSettings`, `watchHotkeys`, `findIcon`, `waitForIcon`, `waitFor`,
`tick`, `delay`, `readMeetingTitle`, `watchMeetEnd`, `subscribeMeetEvents`,
`armTailGrace`, the `meetAdapter` object, and a `main()` that is now:

```ts
async function main(): Promise<void> {
  dlog("adapter loaded", { pathname: location.pathname })
  const tabIdResponse = await sendToBackground<number>({ kind: "getTabId" })
  if (!tabIdResponse.ok) {
    console.error("[platica-notes] could not get tab id:", tabIdResponse.error)
    dlog("could not get tab id", { error: tabIdResponse.error })
    noteIfInvalidated(tabIdResponse)
    return
  }
  const tabId = tabIdResponse.data

  const settings = await getSettings()
  debugEnabled = settings.debugLog
  activeLanguage = settings.captionLanguage
  pushRtcConfig(activeLanguage, settings.debugLog)
  setUiHidden(settings.hideUi)
  watchHotkeys()
  watchSettings()

  // Meet soft-navigates without page loads (landing -> meeting, /new -> meeting,
  // leave screen -> rejoin), so one meeting per page lifetime is not enough: keep
  // watching this tab for meeting pages forever.
  for (;;) {
    await waitFor(() => meetAdapter.isMeetingPage())
    const key = meetAdapter.meetingKey()
    if (!key) continue
    // Refuse to start a NEW session on the just-ended code while Meet is still
    // streaming the final caption tail (see CAPTION_TAIL_GRACE_MS).
    if (shouldDrainTail(key, lastMeetingPath, lastMeetingEndedAt, Date.now(), CAPTION_TAIL_GRACE_MS)) {
      await delay(CAPTION_TAIL_GRACE_MS)
      continue
    }
    await runSession({
      tabId,
      adapter: meetAdapter,
      roster,
      getSelfName: () => selfName,
      setSelfName: (name) => { selfName = name },
      debug: { enabled: () => debugEnabled, events: () => debugEvents, onEvent: (cb) => { onDebugEvent = cb }, log: dlog },
      onContextInvalidated,
      noteIfInvalidated,
    })
    meetAdapter.afterFinalize?.(key)
    // Wait for the residual leave icon to clear before re-arming, capped at the tail
    // grace so a fast rejoin is not blocked forever.
    const rearmStart = Date.now()
    await waitFor(() => shouldFinishRearmWait(!findIcon(LEAVE_ICON_TEXT), Date.now() - rearmStart, CAPTION_TAIL_GRACE_MS))
  }
}
```

- [ ] **Step 3: Write the runner test**

`tests/session-runner.test.ts`, using the existing in-memory chrome fake
(`tests/helpers/chrome-mock.ts`) and a fake adapter whose `subscribe` keeps the emitter
so the test can push events:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installChromeMock } from "./helpers/chrome-mock"
import { runSession } from "../src/content/core/session-runner"
import type { CaptureEvent } from "../src/content/capture/protocol"
import type { PlatformAdapter } from "../src/content/platforms/adapter"

function fakeAdapter(overrides: Partial<PlatformAdapter> = {}) {
  let emit: (e: CaptureEvent) => void = () => {}
  let end: (reason: string) => void = () => {}
  const adapter: PlatformAdapter = {
    id: "zoom",
    capabilities: { chat: true, languageSwitch: "none", rawVersions: true, participantEvents: true, livenessEnd: false },
    captionRules: { interruptionGapMs: null, speakerLabel: (id) => `Speaker ${id}`, selfChatDedupMs: null },
    isMeetingPage: () => true,
    meetingKey: () => "999",
    waitForJoin: async () => true,
    watchEnd: (onEnd) => { end = onEnd; return () => {} },
    readTitle: () => "Fixture meeting",
    meetingUrl: (key) => `https://example.zoom.us/wc/${key}/join`,
    subscribe: (on) => { emit = on; return () => {} },
    ...overrides,
  }
  return { adapter, emit: (e: CaptureEvent) => emit(e), end: (r = "test") => end(r) }
}
```

Cover, at minimum:
1. A meeting with two utterances and one chat message persists a session under
   `session_<tabId>` whose `transcript` has two turns and `chat` one message.
2. `platform` on the persisted session equals `adapter.id`, and `title` equals
   `readTitle()`.
3. Ending the meeting sends `meetingEnded` exactly once, even if `end()` fires twice.
4. A `roster` event followed by an utterance from that speaker resolves the real name.
5. With `capabilities.chat: false`, a chat event does not reach the persisted session.

- [ ] **Step 4: Run the whole suite**

```bash
npm run typecheck && npm test
```
Expected: typecheck clean, all previous tests plus the new runner cases passing.

- [ ] **Step 5: Verify on a live Meet call before committing anything further**

Build, load `dist/` unpacked, join a real meeting and confirm: the pill appears,
captions land in the panel, a note lands, leaving the call writes the `.md`, and a
mid-meeting reload resumes the same session. This is the only gate that covers the
seven ordering invariants; the unit suite cannot.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): extract the platform-neutral session runner

runMeeting's 459 lines split into core/session-runner.ts (session lifecycle,
UI, persistence, finalize) and a Meet adapter that supplies only join/leave
detection, the title, the meeting key and the event stream. Ordering invariants
around stale-session finalize, the pre-flush write and the teardown sequence are
preserved verbatim; the runner is now unit-testable against a fake adapter.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Capability gating and capture health

**Files:**
- Create: `src/content/core/health.ts`
- Modify: `src/content/capture/protocol.ts` (add the health event), `src/content/capture/meet/main.ts` (emit it), `src/content/core/session-runner.ts`, `src/content/core/ui.ts`, `src/content/core/transcript-panel.ts`, `src/shared/types.ts`, `src/background/format.ts`, `src/background/sessions.ts`
- Test: `tests/health.test.ts` (new), `tests/format.test.ts`

- [ ] **Step 1: Write the health state machine test first**

`tests/health.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { nextHealth, type Health } from "../src/content/core/health"

const at = (s: number) => new Date(Date.UTC(2026, 6, 30, 9, 0, s)).toISOString()

describe("capture health", () => {
  it("starts armed and never alarms on silence alone", () => {
    let h: Health = { code: "armed", since: at(0) }
    h = nextHealth(h, { kind: "tick", now: at(120) })
    expect(h.code).toBe("armed")
  })

  it("goes capturing on the first accepted utterance", () => {
    const h = nextHealth({ code: "armed", since: at(0) }, { kind: "utterance", now: at(3) })
    expect(h.code).toBe("capturing")
  })

  it("alarms when the channel never opened inside the window", () => {
    const h = nextHealth({ code: "opening", since: at(0) }, { kind: "tick", now: at(30) })
    expect(h.code).toBe("no-channel")
  })

  it("keeps a platform-reported reason over its own inference", () => {
    const h = nextHealth({ code: "armed", since: at(0) }, { kind: "reported", code: "host-disabled", now: at(5) })
    expect(h.code).toBe("host-disabled")
  })

  it("returns to capturing after a recovered channel", () => {
    let h: Health = { code: "channel-lost", since: at(10) }
    h = nextHealth(h, { kind: "utterance", now: at(12) })
    expect(h.code).toBe("capturing")
  })
})
```

- [ ] **Step 2: Run it, watch it fail**

```bash
npx vitest run tests/health.test.ts
```
Expected: FAIL — `src/content/core/health.ts` does not exist.

- [ ] **Step 3: Implement `src/content/core/health.ts`**

```ts
/**
 * Why capture is (or is not) producing anything. A pure fold: the runner keeps the
 * current value and feeds inputs in, so the whole thing is unit-testable.
 *
 * The distinction that matters: "the channel is open and nobody is talking" is NOT a
 * fault. Alarming on the absence of speech (as some competitors do, on a 5s timer)
 * cries wolf in every quiet meeting. The alarm-worthy state is the channel never
 * opening, or opening and dying.
 */
export type HealthCode =
  | "opening"            // waiting for the capture channel to come up
  | "armed"              // channel open, waiting for speech — not a fault
  | "capturing"          // at least one utterance accepted
  | "no-channel"         // the channel never opened inside CHANNEL_WAIT_MS
  | "channel-lost"       // it opened, then died, and recreation did not help
  | "captions-off"       // the platform says captions are disabled
  | "host-disabled"      // the host has not enabled transcription (Zoom)
  | "unsupported-client" // an unrecognised client build

export interface Health {
  code: HealthCode
  /** ISO time this code was entered. */
  since: string
  detail?: string
}

export type HealthInput =
  | { kind: "tick"; now: string }
  | { kind: "channel-open"; now: string }
  | { kind: "utterance"; now: string }
  | { kind: "reported"; code: HealthCode; detail?: string; now: string }

// How long a capture channel may take to come up before it counts as broken. Meet
// opens its captions channel within a second or two of join; 25s absorbs a slow join
// and a reconnect without letting a genuine failure sit silent for a whole meeting.
export const CHANNEL_WAIT_MS = 25_000

/** Whether this state should be surfaced to the user as a problem. */
export function isAlarming(code: HealthCode): boolean {
  return code === "no-channel" || code === "channel-lost" || code === "captions-off" || code === "host-disabled" || code === "unsupported-client"
}

export function nextHealth(current: Health, input: HealthInput): Health {
  switch (input.kind) {
    case "utterance":
      return current.code === "capturing" ? current : { code: "capturing", since: input.now }
    case "channel-open":
      return current.code === "capturing" ? current : { code: "armed", since: input.now }
    case "reported":
      return current.code === input.code ? current : { code: input.code, since: input.now, detail: input.detail }
    case "tick": {
      if (current.code !== "opening") return current
      const waited = Date.parse(input.now) - Date.parse(current.since)
      return waited >= CHANNEL_WAIT_MS ? { code: "no-channel", since: input.now } : current
    }
  }
}
```

- [ ] **Step 4: Run the test again**

```bash
npx vitest run tests/health.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Add the health event to the protocol and emit it from Meet**

In `src/content/capture/protocol.ts` add and include in the union:

```ts
// Capture-side liveness of the data path itself, dispatched by the MAIN-world script:
// the channel opening, dying, or the platform saying captions are off. The isolated
// runner folds these into its Health state (core/health.ts).
export interface HealthEvent {
  type: "health"
  code: "channel-open" | "channel-lost" | "captions-off" | "unsupported-client"
  detail?: string
}
```

In `src/content/capture/meet/main.ts`: dispatch `{ type: "health", code: "channel-open" }`
where the captions channel first reaches `readyState === "open"`, and
`{ type: "health", code: "channel-lost" }` in the watchdog path that gives up on
recreating it. Keep the existing `record({ phase: … })` diagnostics untouched.

- [ ] **Step 6: Fold health into the runner and the UI**

In `src/content/core/session-runner.ts`: hold `let health: Health = { code: "opening", since: <join time> }`,
feed `nextHealth` from the subscribe handler (`utterance` and `health` events) and from
the existing end-watch cadence (`tick`). On entering an alarming code, call the UI's
notice once with a human sentence; on returning to `capturing`, clear it. Gate the
whole thing on `deps.adapter.capabilities` where relevant.

Capability gating in the same pass:
- `mountMeetingControls` gets `languageSwitch: Capabilities["languageSwitch"]` and does
  not render the language select when it is `"none"`.
- `mountTranscriptPanel` gets `chat: boolean` and omits chat rows when false.
- The runner skips `mountLanguagePrompt` entirely when `languageSwitch === "none"`.

- [ ] **Step 7: Persist the reason when capture produced nothing**

`src/shared/types.ts`: add `captureHealth?: string` to `ActiveSession` and `Meeting`
(a plain string, so a future code needs no migration).

`src/content/core/session-runner.ts`: in the final snapshot, set
`session.captureHealth = health.code` only when `health.code !== "capturing"`.

`src/background/sessions.ts`: carry `captureHealth: session.captureHealth` into the
finalized `Meeting` (next to `language`).

`src/background/format.ts`: emit `capture: <yamlScalar(code)>` in the front matter when
`meeting.captureHealth` is set, immediately after the `source:` line.

- [ ] **Step 8: Extend the format test**

In `tests/format.test.ts` add two cases: a meeting with `captureHealth: "host-disabled"`
emits exactly one `capture: "host-disabled"` line in the front matter; a meeting without
it emits no `capture:` line at all. Assert the value goes through `yamlScalar` by
passing a code-like string containing a quote and checking it is escaped.

- [ ] **Step 9: Verify**

```bash
npm run typecheck && npm test && npm run build
```
Expected: all green, `dist/` builds.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(core): capability gating and a capture health status

Adapters declare what they cannot do, so the UI hides dead controls instead of
offering them. Health distinguishes an open channel with nobody talking (fine)
from a channel that never opened (a fault), and a meeting that captured nothing
records why in its front matter instead of looking like our bug.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Optional permissions and the Zoom skeleton

**Files:**
- Create: `src/content/capture/zoom/map.ts`, `src/content/capture/zoom/main.ts`, `src/content/platforms/zoom.ts`
- Create: `tests/zoom-map.test.ts`
- Modify: `public/manifest.json`, `build.mjs`, `src/background/index.ts`, `src/pages/options/options.ts`, `public/options.html`
- Modify: `README.md` (the browser-client-only limitation)

Scope discipline: transcript, title, roster and join/leave only. No chat, no language
control, no store-listing changes.

- [ ] **Step 1: Write the mapper test first**

`tests/zoom-map.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest"
import { ZoomMapper } from "../src/content/capture/zoom/map"

describe("zoom action mapper", () => {
  let m: ZoomMapper
  beforeEach(() => { m = new ZoomMapper() })

  it("maps a live-transcript collection to utterances with a per-id counter", () => {
    const first = m.map({
      type: "SET_NEW_L_T_MESSAGE",
      payload: { collection: { x: { msgId: "7", text: "hello", user: { zoomID: "u1", displayName: "Grace Hopper" } } } },
    })
    const second = m.map({
      type: "SET_NEW_L_T_MESSAGE",
      payload: { collection: { x: { msgId: "7", text: "hello there", user: { zoomID: "u1", displayName: "Grace Hopper" } } } },
    })
    expect(first).toEqual([
      { type: "roster", speakerId: "u1", name: "Grace Hopper" },
      { type: "utterance", speakerId: "u1", utteranceId: "7", revision: 1, text: "hello" },
    ])
    expect(second[1]).toMatchObject({ revision: 2, text: "hello there" })
  })

  it("keeps counters independent per utterance id", () => {
    m.map({ type: "SET_NEW_L_T_MESSAGE", payload: { collection: { a: { msgId: "1", text: "a", user: { zoomID: "u1", displayName: "Ada" } } } } })
    const other = m.map({ type: "SET_NEW_L_T_MESSAGE", payload: { collection: { b: { msgId: "2", text: "b", user: { zoomID: "u1", displayName: "Ada" } } } } })
    expect(other[1]).toMatchObject({ utteranceId: "2", revision: 1 })
  })

  it("drops entries with no text or no speaker", () => {
    expect(m.map({ type: "SET_NEW_L_T_MESSAGE", payload: { collection: { a: { msgId: "1", text: "", user: { zoomID: "u1" } } } } })).toEqual([])
    expect(m.map({ type: "SET_NEW_L_T_MESSAGE", payload: { collection: { a: { msgId: "1", text: "hi" } } } })).toEqual([])
  })

  it("strips NUL and replacement characters and refuses oversized text", () => {
    const out = m.map({ type: "SET_NEW_L_T_MESSAGE", payload: { collection: { a: { msgId: "1", text: "a b�c", user: { zoomID: "u1", displayName: "Ada" } } } } })
    expect(out[1]).toMatchObject({ text: "abc" })
    const huge = "x".repeat(70_000)
    expect(m.map({ type: "SET_NEW_L_T_MESSAGE", payload: { collection: { a: { msgId: "2", text: huge, user: { zoomID: "u1", displayName: "Ada" } } } } })).toEqual([])
  })

  it("maps the roster, the title and nothing else", () => {
    expect(m.map({ type: "SET_MEETING_TOPIC", payload: { meetingTopic: "Weekly sync" } })).toEqual([])
    expect(m.title).toBe("Weekly sync")
    expect(m.map({ type: "UNRELATED_ACTION", payload: {} })).toEqual([])
  })

  it("survives a malformed action without throwing", () => {
    expect(() => m.map(null)).not.toThrow()
    expect(() => m.map({ type: "SET_NEW_L_T_MESSAGE" })).not.toThrow()
    expect(m.map({ type: "SET_NEW_L_T_MESSAGE", payload: { collection: null } })).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, watch it fail**

```bash
npx vitest run tests/zoom-map.test.ts
```
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/content/capture/zoom/map.ts`**

A class (it holds the per-id revision counters) with `map(action: unknown): CaptureEvent[]`,
a `title` getter, and a `joined` flag set by `JOIN_MEETING_SUCCESS`. Handle exactly:
`SET_NEW_L_T_MESSAGE` (live transcript collection), `UPDATE_MESSAGE` (single caption
revision: `{ userId, previousDisplayName, srcMsgID, message }`), `SET_MEETING_TOPIC`,
`JOIN_MEETING_SUCCESS`. Sanitise text the same way `proto.ts` does for Meet: strip NUL
and U+FFFD, drop empty-after-trim, refuse anything over 65_535 characters. Every field
read must be defensive — this is untrusted page data, and the whole file is pure so the
hostile cases above are cheap to cover.

- [ ] **Step 4: Run the test again**

```bash
npx vitest run tests/zoom-map.test.ts
```
Expected: PASS.

- [ ] **Step 5: Implement the MAIN-world hook `src/content/capture/zoom/main.ts`**

Runs at `document_start` in the MAIN world with `allFrames: true`. Install an accessor on
`window.Redux` so the hook lands the moment the client's bundle assigns it — no
load-order race and no iframe polling (the iframe runs its own copy of this script):

```ts
// The Zoom web client loads Redux as a global before creating its store. Defining an
// accessor now means we wrap createStore/configureStore the instant the bundle assigns
// window.Redux, with no dependency on script load order. Tactiq instead appends a
// script on redux.min.js's onload and then polls the PWA iframe for contentWindow.Redux;
// with allFrames we get the iframe for free and skip the race entirely.
```

Wrap `createStore`, `legacy_createStore` and `configureStore`; on every dispatched
action, feed `ZoomMapper` and dispatch the resulting `CaptureEvent`s over the existing
`RTC_EVENT` bridge. Emit `{ type: "health", code: "channel-open" }` once the store hook
is installed, and `{ type: "health", code: "unsupported-client" }` if `window.Redux`
never appears within 15 seconds of a meeting path.

Never read anything but the actions listed in step 3, and never touch the page's own
state. No `fetch`, no listeners on user input.

- [ ] **Step 6: Implement `src/content/platforms/zoom.ts`**

The isolated-world adapter: the same shape as `meetAdapter`, with
`capabilities: { chat: false, languageSwitch: "none", rawVersions: true, participantEvents: true, livenessEnd: false }`,
`captionRules: { interruptionGapMs: null, speakerLabel: (id) => \`Speaker ${id}\`, selfChatDedupMs: null }`,
`isMeetingPage()` matching `/^\/wc\/(\d+)\/(join|start)/` on `*.zoom.us`,
`meetingKey()` returning the numeric id, `waitForJoin` resolving on the mapper's
`JOIN_MEETING_SUCCESS` (forwarded as a `health: channel-open` plus the first roster
event) or on the presence of the in-call container, `watchEnd` polling for the leave of
the meeting path, `readTitle()` from the last `SET_MEETING_TOPIC`, and
`meetingUrl(key)` rebuilding `https://<host>/wc/<key>/join`. Its `main()` is the same
soft-nav loop as Meet's, calling `runSession` with this adapter.

- [ ] **Step 7: Wire the build, the manifest and the runtime registration**

`build.mjs`: add `"content-zoom": "src/content/platforms/zoom.ts"` and
`"capture-zoom": "src/content/capture/zoom/main.ts"`.

`public/manifest.json`: add
`"optional_host_permissions": ["*://*.zoom.us/*"]`. Do **not** add a static
`content_scripts` entry.

`src/background/index.ts`: on install and on startup, register the Zoom scripts when the
permission is already granted, and expose a message the options page uses to
grant/revoke:

```ts
const ZOOM_SCRIPTS: chrome.scripting.RegisteredContentScript[] = [
  { id: "zoom-capture", matches: ["*://*.zoom.us/wc/*"], js: ["capture-zoom.js"], runAt: "document_start", world: "MAIN", allFrames: true, persistAcrossSessions: true },
  { id: "zoom-content", matches: ["*://*.zoom.us/wc/*"], js: ["content-zoom.js"], persistAcrossSessions: true },
]
```
Register only after `chrome.permissions.contains({ origins: ["*://*.zoom.us/*"] })`
returns true; unregister on `chrome.permissions.onRemoved`.

`src/pages/options/options.ts` + `public/options.html`: a checkbox "Record Zoom meetings
(experimental)" that calls `chrome.permissions.request` and states plainly that it only
works when you join the meeting in this browser, not in the Zoom desktop app.

- [ ] **Step 8: Verify**

```bash
npm run typecheck && npm test && npm run build
```
Expected: all green. Load `dist/` unpacked, enable Zoom in the options page, and join a
real Zoom **web client** meeting with live transcription on: the panel fills, leaving
writes the `.md` with `source: zoom-live-captions`. With transcription off, the meeting
records nothing and the file (if any) carries the `capture:` reason.

If `window.Redux` never appears, fall back to Tactiq's approach — inject after the
`redux.min.js` / `externals.min.js` script's `onload` — and record what the live client
actually exposes in `.claude/session-log.md`.

- [ ] **Step 9: Note the limitation in the README**

One short paragraph: Zoom and Teams desktop apps are invisible to any browser
extension, so recording those platforms requires joining in the browser. No store copy
changes in this task.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(zoom): minimal Zoom web-client capture behind an optional permission

Proves the adapter contract on a second platform: Redux-action interception in the
MAIN world, a pure action->event mapper with hostile-input coverage, transcript and
roster and title only. Off by default; the user grants the zoom.us host themselves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** Canonical event (Task 1), CaptionRules (2), lifecycle split (3),
  adapter contract (4), generic runner (5), capabilities + health + front matter (6),
  optional permissions + injection + Zoom skeleton (7). The spec's `format.ts` source-tag
  item needed no task: `PLATFORM_SOURCES` already carries `zoom`/`teams`.
- **Naming consistency.** `CaptureFeed` (not `RtcFeed`) from Task 2 onward;
  `speakerId`/`utteranceId`/`revision` everywhere after Task 1; `RosterEvent` /
  `RosterLeaveEvent` deliberately avoid colliding with `shared/types.ts`'s
  `ParticipantEvent`; `runSession` (not `runMeeting`) in core.
- **Known risk not solved by this plan.** Task 5 is a large behaviour-preserving move
  whose real gate is a live Meet call, not the unit suite. Do not merge to `main` on a
  green suite alone.
