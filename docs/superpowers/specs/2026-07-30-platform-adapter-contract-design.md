# Platform adapter contract — design

**Date:** 2026-07-30
**Branch:** `feat/platform-adapter-contract`
**Status:** approved (product-level), technical detail owned by the implementer

## Why

Plática Notes captures Google Meet only. Adding Zoom and MS Teams is wanted, and the
mechanics for both are now known: they were read off Tactiq 3.1.6319's shipped code
(`zoom.inline.js`, `msteams.inline.js`, `rtcinjector.js`) — see the research notes in
`.claude/session-log.md` (2026-07-30) and the memory `check-tactiq-before-inventing`.

The blocker is not the wire format, it is that half the Meet code is a single
459-line `runMeeting()` in `src/content/platforms/meet.ts` that mixes generic
session lifecycle with Meet DOM specifics. A second platform cannot reuse any of it.

This spec covers **only** the refactor plus a deliberately minimal Zoom skeleton that
proves the seam. Zoom feature-completeness and Teams are separate future work.

## Decisions taken (product-level, confirmed by the owner)

1. **Adapter layer first**, before any full platform implementation.
2. **A minimal Zoom skeleton ships with the refactor** as the contract's probe:
   transcript, meeting title, join/leave only. No chat, no language pill, no polish.
   Rationale: an abstraction validated by one implementation is Meet wearing neutral
   names. The skeleton is a test of the seam, not a feature.
3. **Full generic runner**: the session lifecycle moves out of `runMeeting()` into
   platform-neutral core, not a parameterised in-place version.
4. **Capability flags plus a capture health status.** Features a platform cannot do are
   declared, not silently absent, and the reason capture is producing nothing is
   surfaced. This also closes a long-standing Meet gap (no "captions never started"
   alarm — noted as MED in the 2026-07 Tactiq audit).
5. **Optional host permissions.** Zoom/Teams hosts are requested at runtime when the
   user enables the platform, never declared statically. Softer store review, honest
   privacy story, and the default install still sees only Meet.
6. **Browser-client only, no link rewriting.** Desktop Zoom/Teams clients are
   unreachable by any extension. Tactiq answers this with a `declarativeNetRequest`
   rule that rewrites `zoom.us/j/…` into the web client; we do not. The limitation is
   stated plainly in the UI and the docs. A redirect may be reconsidered later.
7. All work happens on `feat/platform-adapter-contract`; `main` stays releasable while
   1.14.0 is under Chrome Web Store review.

## Non-goals

- MS Teams support (design informed by it; no code).
- Zoom chat, Zoom language switching, Zoom host-side caption enabling.
- Any network egress, on any platform, ever. Unchanged invariant.
- Shipping Zoom to the store. The skeleton is dev-only until it earns a release.

## Architecture

Three layers, replacing today's two-and-a-half.

### `src/content/capture/` — MAIN-world capture, one directory per platform

- `protocol.ts` — moved from `meet-rtc/bridge.ts`: `CustomEvent` names, the canonical
  event types, JSON-string payloads across the world boundary. **The event name
  `platica-rtc` and the payload shape are load-bearing outside the extension**:
  `scripts/screenshots.mjs` feeds fixtures into the real `dist/` through this bridge.
  It is updated in the same commit as the protocol.
- `capture/meet/` — today's `meet-rtc/` minus `feed.ts`: `main.ts`, `proto.ts`,
  `identity.ts`, `build-probe.ts`, `lifecycle.ts`.
- `capture/zoom/` — `main.ts` (Redux interception) and `map.ts` (Redux action →
  canonical event, a pure function tested on fixtures without a browser).

### `src/content/core/` — platform-neutral core

- `session-runner.ts` — **new**, extracted from `runMeeting()`: session start/resume,
  `SessionWriter`, UI mounting, attendee and roster bookkeeping, notes and hotkeys,
  the debug log, the tail-grace pacing, finalize. Takes a `PlatformAdapter`.
- `feed.ts` — moved from `meet-rtc/` (it was always core, never Meet), plus the
  `CaptionRules` profile below.
- `health.ts` — **new**, the capture health state machine.
- `session-lifecycle.ts` — **new**: the platform-neutral pure helpers out of
  `meet-lifecycle.ts` (`seedAttendees`, `isMidMeetingJoin`, `shouldAskLanguage`,
  `shouldFinalizeStaleSession`).
- Unchanged: `collector.ts`, `persistence.ts`, `ui.ts`, `transcript-panel.ts`,
  `hotkeys.ts`.

### `src/content/platforms/` — isolated world, one file per platform

- `adapter.ts` — the `PlatformAdapter` interface, `Capabilities`, `Health` types.
- `meet.ts` — Meet only: the DOM-contract block (`call_end`, `.u6vdEc`), the soft-nav
  loop, media-based end detection, caption language, the `chat.google.com` own-chat
  path, its own constants. Expected ~250-300 lines, down from 834.
- `meet-lifecycle.ts` — keeps the Meet-specific pure helpers (`nextLeaveState`,
  `nextMediaZeroSince`, `shouldEndFromMedia`, `shouldDrainTail`,
  `shouldFinishRearmWait`). Tests split symmetrically with the core ones.
- `zoom.ts` — the skeleton.

### Build entry points

`content-meet`, `content-zoom`, `capture-meet` (was `meet-rtc-main`), `capture-zoom`,
`chatgoogle-main`, plus the existing pages. Renaming outputs touches
`public/manifest.json`; verified by loading `dist/` unpacked.

## The canonical capture event

All three platforms reduce to the same shape on the wire — `(who, utterance id,
revision ordinal, cumulative text)`. Meet carries it in protobuf fields `f1/f2/f3/f6`,
Zoom in `SET_NEW_L_T_MESSAGE` (`user.zoomID`, `msgId`), Teams in `recognitionResults`
(`userId`, `timestampAudioSent`). So the protocol is one type, not three.

```ts
type CaptureEvent =
  | { type: "utterance"; speakerId: string; utteranceId: string; revision: number; text: string }
  | { type: "chat"; speakerId: string; text: string; sender?: string; messageId?: string }
  | { type: "participant"; speakerId: string; name: string }
  | { type: "participant-leave"; speakerId: string; name?: string }
  | { type: "self"; name: string }
  | { type: "liveness"; openSessions: number; state: RTCPeerConnectionState }
  | { type: "health"; code: HealthCode; detail?: string }
```

Two invariants the contract states in writing, because violating either makes the core
lose text silently:

- **`text` is cumulative**, never a delta. `feed.ts` strips the already-emitted prefix
  via `suffixAfter`.
- **`revision` strictly increases within an `utteranceId`.** The feed drops
  `revision <= existing`. Meet reads it off the wire (`f3`); Zoom has no version field
  at all, so `capture/zoom/map.ts` keeps its own per-`msgId` counter. Tactiq substitutes
  `Date.now()` here, which is a defect: two revisions inside one millisecond collide and
  the second is dropped.

`liveness` is Meet's media-session signal. Platforms that do not report it declare
`livenessEnd: false` and detect the end their own way.

## Per-platform caption rules

The three places platforms genuinely diverge, kept as data rather than branching:

```ts
interface CaptionRules {
  interruptionGapMs: number | null   // null: an id never spans another speaker; do not split
  speakerLabel: (speakerId: string) => string
  selfChatDedupMs: number | null     // null: own chat arrives on one transport only
}
```

- Meet: `1000` / tail of `spaces/<id>/devices/<n>` / `5000`.
- Zoom skeleton: `null` / `Speaker <id>` / `null`.

`interruptionGapMs: null` is the honest default for a new platform: Meet's
one-id-spans-an-interruption behaviour is a Meet quirk, unverified elsewhere, and
splitting where it does not happen only fragments turns.

## The adapter interface

```ts
interface PlatformAdapter {
  readonly id: PlatformId
  readonly capabilities: Capabilities
  readonly captionRules: CaptionRules
  isMeetingPage(): boolean
  meetingKey(): string | null                        // Meet: pathname, Zoom: meeting id
  waitForJoin(abort: () => boolean): Promise<boolean>
  watchEnd(onEnd: (reason: string) => void): () => void
  readTitle(): string                                // "" falls back to document.title
  meetingUrl(key: string): string | undefined
  subscribe(on: (e: CaptureEvent) => void): () => void
  setLanguage?(tag: string): void                    // absent = languageSwitch "none"
  afterFinalize?(key: string): void                  // Meet: arm the tail-grace window
}

interface Capabilities {
  chat: boolean
  languageSwitch: "self" | "host-only" | "none"
  rawVersions: boolean
  participantEvents: boolean
  livenessEnd: boolean
}
```

- Meet: everything true, `languageSwitch: "self"`.
- Zoom skeleton: `chat: false`, `languageSwitch: "none"`, `livenessEnd: false`,
  `rawVersions: true`, `participantEvents: true`.

Gating: the language pill does not mount at `"none"`; the transcript panel omits its
chat section when `chat: false`. `src/background/format.ts` needs no change here — its
`PLATFORM_SOURCES` map already carries `zoom` and `teams` entries.

`"host-only"` is defined now but used by no adapter yet: it is what Zoom becomes once
language switching is implemented (Zoom's live transcription is enabled server-side by
the host, and Teams' language choice needs the organiser role). At that value the pill
mounts but reports why a switch failed instead of appearing broken. The skeleton
declares `"none"` and ships no `setLanguage`, consistent with the non-goals.

## Capture health

Tactiq checks "did captions start" on a 5-second timer. That is wrong for us: on Meet the
absence of speech is not a fault, and such a timer cries wolf in a quiet meeting. The
correct signal is the state of the channel itself, which the MAIN-world script already
polls every second.

```ts
type HealthCode =
  | "armed"              // channel open, waiting for speech — NOT an alarm
  | "capturing"          // first utterance accepted
  | "no-channel"         // channel never opened within the window — this is the alarm
  | "channel-lost"       // opened, died, recreation failed
  | "captions-off"       // the platform said captions are disabled
  | "host-disabled"      // Zoom: host has not enabled Live Transcription
  | "unsupported-client" // e.g. an unrecognised Zoom/Teams client build
```

The status lives in the runner, renders in the pill with its reason, and goes to the
debug log. It reaches the saved file as a single front-matter line `capture: <code>`
**only when the code at finalize is not `capturing`** — otherwise an empty transcript
reads as our bug rather than as "the host never switched captions on". That is the only
output-format change; covered in `tests/format.test.ts` and routed through `yamlScalar`
like every other scalar.

## Permissions and injection

`public/manifest.json`:

- `host_permissions` unchanged: `meet.google.com`, `chat.google.com`.
- `optional_host_permissions`: `*://*.zoom.us/*` (Teams patterns added when Teams
  lands).
- Static `content_scripts` stay Meet-only. Zoom scripts are registered at runtime with
  `chrome.scripting.registerContentScripts` (`world: "MAIN"` for capture,
  `persistAcrossSessions: true`), from an options-page toggle that calls
  `chrome.permissions.request` first, and unregistered on revoke.

Zoom injection differs from Tactiq's on purpose. They find the `<script src=…redux.min.js>`
tag and append their script on its `onload`, then poll the PWA iframe for
`contentWindow.Redux`. We instead run at `document_start` in the MAIN world with
`allFrames: true` and install an accessor on `window.Redux` (`Object.defineProperty`
get/set) so the hook lands the moment the bundle assigns it. No load-order race, no
iframe polling — the iframe gets its own instance of the script.

What the Zoom skeleton reads (all confirmed in Tactiq's shipped code):

| Signal | Source |
| --- | --- |
| transcript | `SET_NEW_L_T_MESSAGE` (collection of `{msgId, text, user.zoomID, user.displayName, language}`), `UPDATE_MESSAGE` |
| roster | `attendeesList.attendeesList` (`userId` → `displayName`) |
| title | `SET_MEETING_TOPIC` |
| joined | `JOIN_MEETING_SUCCESS` |
| meeting id | pathname, `*.zoom.us/wc/<id>/{start,join}` |

Store wording (`docs/STORE-LISTING.md`, `PRIVACY.md`) is **not** touched by this branch:
nothing user-visible about Zoom ships until the skeleton earns a release.

## Testing

The existing 398 tests must stay green; that is the primary regression gate for Meet.
New coverage:

- `tests/capture-protocol.test.ts` — contract conformance: a fake adapter drives the
  feed and asserts the cumulative-text and monotonic-revision invariants, including
  that violations are rejected rather than half-applied.
- `tests/zoom-map.test.ts` — Redux action fixtures → canonical events, hostile input
  included (missing `user`, empty text, NUL/replacement chars, oversized text).
- `tests/health.test.ts` — the state machine, especially that silence in an armed
  channel never raises the alarm.
- `tests/session-runner.test.ts` — the runner against the in-memory `chrome.*` fake and
  a fake adapter. This is the real payoff of the extraction: `runMeeting()` is untestable
  today.
- `tests/format.test.ts` — the `capture:` front-matter line.

Fixtures use fictional names and `abc-defg-hij`, per the repo convention.

Manual gates before any release off this branch: a live Meet meeting re-verifying the
DOM-contract block (leave detection, title), `npm run screenshots` regenerating cleanly,
and a live Zoom web-client meeting for the skeleton.

## Work order

1. `protocol.ts` extraction and the neutral event names, plus the matching
   `scripts/screenshots.mjs` update. Mechanical; suite green.
2. `feed.ts` move into core and `CaptionRules` extraction.
3. `session-lifecycle.ts` split out of `meet-lifecycle.ts`.
4. `adapter.ts` and a Meet adapter object assembled from the existing code, still
   driven by today's `main()`/`runMeeting()`. The interface must exist before the
   runner can take it, otherwise step 5 needs a throwaway intermediate type.
5. `session-runner.ts` extraction from `runMeeting()` against that interface;
   `meet.ts` shrinks to platform specifics. Meet is still the only platform.
6. Capabilities gating plus `health.ts` and the front-matter line.
7. Optional permissions, runtime registration, the options toggle, and the Zoom
   skeleton (`capture/zoom/`, `platforms/zoom.ts`).

Steps 1-5 are behaviour-preserving; a Meet regression there is a bug, not a trade-off.
Step 6 changes behaviour (new pill states, new front-matter line). Step 7 adds surface.

## Risks

- **Meet regression while moving 459 lines.** Mitigation: behaviour-preserving steps
  first, full suite after each, a live meeting before any release, screenshots
  regenerated.
- **The Zoom hook may not land.** Tactiq's reading of `window.Redux` is current as of
  3.1.6319, but the Zoom web client can drop the global at any release. If the accessor
  approach fails on a live meeting, fall back to Tactiq's script-`onload` injection. The
  skeleton is scoped so this discovery is cheap.
- **Fragility multiplies with each platform** (internal action names, bundle load order,
  Teams' internal object graph) against a one-person maintenance budget. The health
  status is the mitigation: a broken platform reports why instead of producing empty
  files.
- **1.14.0 is under store review.** Everything stays on the branch; `main` remains
  releasable for a review-requested fix.
