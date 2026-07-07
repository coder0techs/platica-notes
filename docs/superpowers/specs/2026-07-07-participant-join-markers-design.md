# Feature 5 — inline participant join markers

Status: design approved (2026-07-07), pending spec review → writing-plans → TDD.
Branch: `feat/meet-chat-lifecycle-v1.13.0`.

## Goal

Show, inline in the meeting timeline (both the saved `.md` and the live panel),
a timestamped marker when a participant **joins** mid-meeting — the same way a
recorder's note/bookmark renders as its own block. Today only the final roster is
listed in the file's front matter; there is no per-event join/leave log.

## Scope decision (locked with the user)

- **Join: implemented now.** Roster device events (`type:"device"`, deviceId→name)
  already stream into the adapter from the `collections` channel and the
  `SyncMeetingSpaceCollections` RPC. A device id first seen **after** an initial
  settling window is a mid-meeting join.
- **Leave: deferred.** There is no clean leave signal on the wire (the roster
  decoder only yields present devices; the `media` count reflects the local
  connection, not peers). **Tactiq was checked (per project rule): it has no
  join/leave markers at all — only a `participantsCount` — so there is nothing
  proven to mirror for leave.** Instead we add adapter-side classification
  logging (debug) so a future log-based spike can decode leave; the data model
  and both renderers already handle `"leave"`, so adding it later is detection-only.
- **Panel parity: yes.** Markers show live in the transcript panel, like notes.
- **Initial roster: grace window.** Participants already present when recording
  starts get **no** marker (they are in the front-matter roster already); only
  later arrivals do.

## Data model (`src/shared/types.ts`)

```ts
export interface ParticipantEvent {
  at: string          // ISO 8601
  name: string
  kind: "join" | "leave"   // v1 emits only "join"; "leave" reserved
}
```

- `ActiveSession.participantEvents?: ParticipantEvent[]` — rides alongside `notes`
  (persisted in every snapshot, restored on reload/orphan-recovery).
- `Meeting.participantEvents?: ParticipantEvent[]`.

## Join classification — pure (`src/content/platforms/meet-lifecycle.ts`)

```ts
export function isMidMeetingJoin(
  name: string,
  selfName: string | null,
  alreadyKnown: boolean,          // deviceId already accounted for this meeting
  elapsedSinceJoinMs: number,     // measured from THIS runMeeting start, not session.startedAt
  settleMs: number,
): boolean {
  if (alreadyKnown) return false
  if (elapsedSinceJoinMs < settleMs) return false  // initial roster / reload re-sync
  if (selfName && name === selfName) return false   // never mark self
  return true
}
```

Fully unit-tested (all four branches). The caller owns the `known` set.

## Adapter wiring (`src/content/platforms/meet.ts`) — proto.ts / main.ts untouched

Join arrives as an ordinary `device` event the adapter already receives, so no
bridge/MAIN-world change is needed.

- In `runMeeting`: `const joinWatchStart = Date.now()` (settle measured from this
  run — a reloaded session has a huge `session.startedAt` elapsed, which would
  otherwise mark the whole reload re-sync as joins), `const knownDevices =
  new Set(roster.keys())` (seed everyone present at join), `participantEvents =
  [...prefixParticipantEvents]`.
- New meeting-scoped closure `recordDevice(deviceId, name)`: compute
  `alreadyKnown = knownDevices.has(deviceId)`; if `isMidMeetingJoin(...)` push
  `{ at: new Date().toISOString(), name, kind: "join" }`, update
  `session.participantEvents`, `panel.update(...)`, `writer.requestWrite()`,
  `pulseActivity()`. Always `knownDevices.add(deviceId)` + a `dlog` classification
  line (this is the leave-investigation logging).
- Page-level RTC listener: `device` → `recordAttendee(name)` **and**
  `recordDevice(deviceId, name)`; `self` → `recordAttendee` only (self never marked).
- Constant `JOIN_SETTLE_MS = 10000`.
- Reload safety is triple: `known` seeded from the re-seeded roster, settle window
  from a fresh `joinWatchStart`, and restored `prefixParticipantEvents`.

## Timeline (`src/shared/transcript.ts`)

- `TimelineEntry.kind` → `"speech" | "chat" | "note" | "join" | "leave"`.
- `KIND_ORDER` → `{ join: 0, speech: 1, chat: 2, leave: 3, note: 4 }`.
- `flattenTimeline` and `mergeTimeline` take a 4th param
  `participantEvents: ParticipantEvent[] = []`, mapped to
  `{ kind, speaker: name, text: "", at, endAt: at }` (note the `endAt` field added
  by the parallel panel-pause commit — join/leave are instantaneous so `endAt = at`).
- In `mergeTimeline`, join/leave are non-speech, so the existing `continues` guard
  (requires speech on both sides) already breaks a speaker's run around them — no
  special handling.

## Saved-file render (`src/background/format.ts`)

A join/leave is an annotation like a note — render it as a heading block, name
through `inlineText` (heading-injection safe), no blockquote body:

```
### Joined · <name> · HH:MM · +mm:ss
### Left · <name> · HH:MM · +mm:ss     (reserved; nothing emits "leave" yet)
```

## Panel render (`src/content/core/transcript-panel.ts`)

Like notes: an icon + accent colour, no body. `👋 <name> joined` / `🚪 <name> left`.
`update()` gains a `participantEvents` arg; all `panel.update(...)` calls in meet.ts
pass `session.participantEvents ?? []`.

## Finalize / merge / empty

- `sessions.ts`: `participantEvents: session.participantEvents ?? []` on `Meeting`.
- `merge.ts`: concatenate like `notes` (flattenTimeline re-sorts by time).
- Empty rule unchanged: a session with only join markers (no transcript/chat/notes)
  stays empty → no `.md`. Join markers alone are not worth a file.

## Tests (TDD)

- `meet-lifecycle.test.ts`: `isMidMeetingJoin` — all four branches.
- `transcript.test.ts`: flatten + merge with participant events (sort, tie-break,
  speaker-run break, `endAt`).
- `format.test.ts`: join → heading; leave → heading (forward); name injection safe;
  no body.
- `sessions`/`store` + `merge.test.ts`: pass-through + concatenation.
- Panel has no unit harness (DOM glue) — covered by the pure timeline tests.

## Accepted trade-offs (documented in code)

- A participant present at start whose device event lands just **after** the settle
  window gets a false "joined". Mitigated by the `known` seed + window; residual
  accepted.
- A self device event after the window but before `selfName` resolves could read as
  "self joined". `UpdateMeetingDevice` fires at join (inside the window) in practice;
  residual accepted.
- Leave has no detection; raw bytes for a future spike are already in the debug log
  (`channel-raw`/`roster-decoded` on `collections`) plus the new adapter
  classification log.
```
