# RTC media-end signal — design

> Roadmap item #6, open point **O5**. Make Meet-meeting *end* detection rest on
> an authoritative WebRTC signal instead of relying solely on DOM selectors
> (`call_end` icon, meeting title) plus the path regex.
>
> **Date:** 2026-06-29. **Branch:** `feat/rtc-media-end-signal`.
> **Scope:** v1 is **additive** — the RTC signal becomes an authoritative end
> trigger that can finalize on its own, while the existing DOM triggers stay
> exactly as they are (cheap backup). Demoting/removing the fragile icon-poll is
> **phase 2**, gated on seeing more reconnect variety in the wild.

## Problem

The whole meeting lifecycle in `src/content/platforms/meet.ts` keys off a few
fragile inputs:

- a delegated click on the `call_end` icon (`LEAVE_ICON_TEXT`),
- a 2 s poller (`nextLeaveState`) that ends when the path changes **or** the
  `call_end` icon is missing for 3 consecutive checks,
- the meeting-path regex.

If Meet churns its markup (icon glyph, title selector), end detection breaks
silently — exactly the contract the project flags as "the most likely thing to
break". We hit three data-loss bugs in this area (1.6.1, 1.6.3, native-caption
toggle). Item #6 is about making the handling deliberate rather than discovered
bug-by-bug; O5 is the highest-leverage piece because the same authoritative
signal hardens almost every row of the scenario matrix.

## The signal already exists — it just never crosses the bridge

`src/content/meet-rtc/main.ts` already maintains the ground truth:

- `sessions: MediaSession[]` — one entry per open `media-session` data channel
  (one per `RTCPeerConnection`), page-level, shared across meetings in the tab.
- The channel `open`/`close` listeners push/splice this array and already emit a
  debug record carrying `sessions: sessions.length` and `pc.connectionState`
  ([main.ts](../../../src/content/meet-rtc/main.ts) ~L430–437).

That count is the authoritative liveness of the call's media path. Today it is
only written to the **debug** stream (`record()`), never `dispatch()`-ed across
the bridge, so the isolated-world adapter cannot see it.

## Evidence from 50 real debug logs

Characterised `~/Downloads/meetings/platica-notes-logs/*.jsonl` (52 files,
50 finalized meetings). Method: read the `sessions` field on every
`media-session-open/closed`, and cross-check each close against how much
transcript and time followed it.

1. **`openSessions → 0` is a clean end signal.** 22/22 zero-episodes were the
   genuine end (`pc=closed`, never recovered). The count never hit 0 and bounced
   back mid-meeting.
2. **The one mid-meeting reconnect did NOT zero out.** "CO _ Credit Card Concept"
   (2026-06-29): a `media-session-closed` with `sess=1`, followed by **1239 more
   transcripts over 426 s**. Meet brought up the new peer connection *before*
   tearing down the old (make-before-break): the count went 2→1, never 0. The
   matching `captions-recreate` shows `pc=connected`. ⇒ **Trigger on
   `openSessions === 0`, not on the `media-session-closed` event itself**, and
   this reconnect class is immune by construction.
3. **Measured win.** On the "left without clicking" class (kicked / host ended /
   keyboard leave) — the branch the icon-poll covers today — the
   `media-session-closed` *led* the adapter's `meeting ended` marker by **~5 s**
   (e.g. +5.3, +5.2, +5.0, +5.8, +4.6 s). On the leave-click class the pc closed
   ~0.5 s *after* the click (the click already finalized). RTC wins on exactly
   the fragile branch, ~5 s sooner and without depending on DOM.
4. **What the corpus does NOT cover.** All desktop, good-network meetings. A hard
   drop (laptop sleep, Wi-Fi loss) with no make-before-break — where the count
   could briefly hit 0 and recover — is unobserved. This residual risk is why we
   (a) keep a grace window on the `count==0` trigger, and (b) keep the icon-poll
   as backup in v1 rather than removing it.

## Design

### Principle

`main.ts` reports **facts**; `meet.ts` / `meet-lifecycle.ts` make **decisions**.
The new media-liveness fact joins `device`/`self` as an always-on dispatched
event (NOT debug-gated). The end **decision** is a pure function, unit-tested
against synthetic event sequences.

### 1. New bridge event (`src/content/meet-rtc/bridge.ts`)

```ts
export interface RtcMediaEvent {
  type: "media"
  openSessions: number          // sessions.length after the mutation
  pcState: RTCPeerConnectionState
}
export type RtcEvent = RtcCaptionEvent | RtcChatEvent | RtcDeviceEvent | RtcSelfEvent | RtcMediaEvent
```

Carries a count and a connection-state string only — **no transcript content**,
so the zero-network and XSS-safe invariants are untouched.

### 2. Dispatch the fact (`src/content/meet-rtc/main.ts`)

In `handleChannel` for the `media-session` channel, alongside the existing
`record()` calls, `dispatch()` the current count:

- on registration / `open` → `dispatch({ type:"media", openSessions: sessions.length, pcState: pc.connectionState })`
- in the `close` listener (after the splice) → same dispatch with the new length.

`dispatch()` is the always-on path (used by transcript/chat/device/self), so the
adapter sees media facts regardless of the debug flag. The existing debug
`record()` lines stay (free diagnostics). `pruneDeadSessions()` is GC only — it
removes channels whose `close` already fired (and already dispatched), so no
extra dispatch is needed there.

### 3. Pure decision (`src/content/platforms/meet-lifecycle.ts`)

Two pure helpers keep the adapter glue trivial and the logic fully unit-tested
without timers, by feeding synthetic `(count, now)` sequences:

```ts
// Fold each media event into the "first zero" timestamp. Null whenever the path
// is live (> 0), so a session reopening cancels a pending end; the first zero
// stamps `now`; further zeros keep that stamp so the grace measures from when the
// path actually went down.
export function nextMediaZeroSince(prev: number | null, openSessions: number, now: number): number | null {
  if (openSessions > 0) return null
  return prev ?? now
}

// All media sessions have been closed for at least graceMs → the call's media
// path is authoritatively down.
export function shouldEndFromMedia(zeroSince: number | null, now: number, graceMs: number): boolean {
  return zeroSince !== null && now - zeroSince >= graceMs
}
```

Symmetric with the existing helpers (`nextLeaveState`, `shouldFinishRearmWait`).

### 4. Wiring (`src/content/platforms/meet.ts`)

- A page-level `onMediaState: ((openSessions:number)=>void) | null`, set in
  `runMeeting` after join, nulled in `endMeeting` (same block that nulls
  `activeMeetingHandler`). Routed from the existing `RTC_EVENT` listener:
  `if (parsed.type === "media") { onMediaState?.(parsed.openSessions); return }`.
  Between meetings it is null, so a stray `media:0` is ignored — nothing to
  finalize.
- A meeting-scoped `mediaZeroSince: number | null`, updated by `onMediaState` via
  `nextMediaZeroSince(mediaZeroSince, openSessions, Date.now())` (the reconnect
  cancel lives in that pure helper).
- **Reuse the existing `endWatcher` interval** (2 s) for the decision — no second
  timer. Each tick, in addition to `nextLeaveState`:
  `if (shouldEndFromMedia(mediaZeroSince, Date.now(), MEDIA_END_GRACE_MS)) void endMeeting("rtc: all media sessions closed")`.
- `endMeeting` is unchanged and idempotent (the `ending` guard). The RTC path and
  the DOM paths all funnel through it; whichever fires first wins, the rest no-op.

```
MEDIA_END_GRACE_MS = 5000   // single calibration knob.
// Genuine ends sit at 0 and finalize < 2 s; the only observed reconnect was
// make-before-break (never 0); 5 s covers a brief drop-reconnect with margin.
// Evaluated on the 2 s endWatcher cadence, so effective latency is ~6 s — below
// the existing tail-grace budget and invisible next to CAPTION_FLUSH_MS (2.5 s).
```

### 5. Scenario-matrix impact (no regressions; additive only)

| # | Scenario | Today | With O5 v1 |
|---|---|---|---|
| 1 | Leave click | click → flush → finalize | unchanged (click still leads; media:0 follows, no-op under `ending`) |
| 2 | Keyboard / kicked / host ends | icon-poll, up to ~6 s | **RTC finalizes ~5 s sooner**; icon-poll still backs it |
| 3 | Navigate to non-meeting URL | poller (path) | unchanged (RTC also sees media:0 — corroborates) |
| 4 | Fast rejoin same code | drain-tail grace | unchanged; RTC end keyed to current meeting, new session re-arms count |
| 5 | Leave → different code, reload | stale finalize before overwrite | unchanged (background path untouched) |
| 6 | Leave → different code, soft-nav | sequential loop | media:0 between meetings → RTC ends meeting 1 cleanly even if icon lingers |
| 9 | Reload mid-meeting | resume from snapshot | unchanged — main.ts torn down, no media handler; resume drives it |
| 14 | Hidden/background tab freeze | capture pauses | unchanged — frozen tab delivers no RTC events either (O3, out of scope) |

The remaining rows (7, 8, 10, 11, 12, 13, 15, 16) do not interact with the media
end-signal in v1.

### Out of scope (v1)

- **icon-poll demotion** → phase 2, after wild reconnect variety is observed.
- **O1** (lingering unfinalized session after reload→non-meeting, #10): orthogonal
  — needs a background heartbeat/timeout, not a media signal (no live handler in
  that state).
- **O4** (roster loss on ultra-fast rejoin): separate (roster cache by meeting id).
- Any change to `src/background/**` — the existing `meetingEnded`→`finalizeSession`
  path is reused verbatim. **This keeps the conflict surface with the parallel
  session-merging work (#5) at zero.**

## Invariants preserved

- **Zero network egress** — the media event is a local CustomEvent with a count
  and a state string; no `fetch`/XHR/socket added.
- **XSS-safe DOM** — no untrusted string added to any DOM path.
- **Privacy flag** — finalization path unchanged; private meetings route as before.
- **DOM contract** — not removed in v1; the new signal sits beside it.

## Testing

- `nextMediaZeroSince`: stays null while open; stamps first zero; carries the
  first stamp forward; resets to null when a session reopens (reconnect cancel).
- `shouldEndFromMedia`: null ⇒ false; inside grace ⇒ false; at/after grace ⇒ true.
- Existing `meet-lifecycle` tests must stay green (no behavioural change to the
  DOM helpers).
- Manual live re-verification before release (per project policy): confirm a
  normal leave, a host-ended call, and a deliberate Wi-Fi drop + reconnect behave
  as designed, using the debug log.

## Open questions (non-blocking)

- Exact `MEDIA_END_GRACE_MS` — 5 s is evidence-based but conservative; phase-2
  live data (mobile, real drops) may tune it.
- Whether to also surface `pcState` into the decision (e.g. end faster when
  `pcState==="closed"` and count 0). Deferred: count-based + grace already covers
  the observed cases; adding pcState is a latency optimisation, not a correctness
  fix, and risks over-fitting to current Meet behaviour.
