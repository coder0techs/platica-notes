# Merge repeated visits of the same meeting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `mergeRejoins` is on, fold sequential rejoins of the same Meet code (within a 2 h gap) into one `Meeting` and one `.md` file instead of one per visit.

**Architecture:** All merge logic runs in the background at finalize, *after* the visit is committed to the `meetings` store — the per-`tabId` capture path is untouched (preserves the 1.6.3 data-loss guarantee). A pure `merge.ts` holds identity + merge math; `store.ts` does the atomic read-decide-write; `export.ts` overwrites the file for merged meetings; `format.ts` renders visit separators. Spec: `docs/superpowers/specs/2026-06-30-merge-rejoined-visits-design.md`.

**Tech Stack:** TypeScript, esbuild, vitest. No runtime deps. In-memory `chrome.*` fake (`tests/helpers/chrome-mock.ts`) for background tests.

**Coordination:** ROADMAP #6 / O5 (`feat/rtc-media-end-signal`) is in flight but touches a disjoint file set (content-world only). No conflict expected. Whoever merges to `main` second runs the full suite on the combined tree.

---

## File structure

- **Create** `src/background/merge.ts` — pure: `MERGE_GAP_MS`, `meetCodeFromUrl`, `shouldMerge`, `mergeMeetings`.
- **Create** `tests/merge.test.ts` — unit coverage for the pure module.
- **Modify** `src/shared/types.ts` — `VisitSpan`, `Meeting.visits`, `Settings.mergeRejoins`, `DEFAULT_SETTINGS`.
- **Modify** `src/background/store.ts` — `commitFinalizedMeeting`.
- **Modify** `src/background/sessions.ts` — call `commitFinalizedMeeting` instead of `addMeeting`.
- **Modify** `src/background/export.ts` — `conflictAction` from `visits.length`.
- **Modify** `src/background/format.ts` — visit separators.
- **Modify** `src/pages/options/options.ts` + `public/options.html` — the toggle.
- **Modify** `src/pages/history/history.ts` — `· N visits` suffix.
- **Extend** `tests/{store,sessions,export,format}.test.ts`.
- **Modify** `README.md`, `CHANGELOG.md`.

---

## Task 1: Types — `visits`, `mergeRejoins`

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add `VisitSpan` + `Meeting.visits`.** After the `Meeting` interface's `meetingUrl` field, add `visits`, and add the `VisitSpan` interface just above `Meeting`:

```ts
/** One visit's time span within a merged meeting. Absent on single-visit meetings. */
export interface VisitSpan {
  startedAt: string // ISO 8601
  endedAt: string // ISO 8601
}
```

In `Meeting`, after `meetingUrl?: string`:

```ts
  /**
   * Per-visit spans when this meeting was assembled from several rejoins of the
   * same Meet code (see merge.ts). Absent (undefined) for a normal single-visit
   * meeting. `visits.length > 1` is the canonical "this is merged" signal.
   */
  visits?: VisitSpan[]
```

- [ ] **Step 2: Add `Settings.mergeRejoins`.** In the `Settings` interface, after `hideUi`:

```ts
  /**
   * Fold sequential rejoins of the same meeting (same Meet code, within a 2 h
   * gap) into one .md file instead of one per visit. Off by default so the
   * existing per-visit behaviour (and anything consuming those files) is
   * unchanged until the user opts in.
   */
  mergeRejoins: boolean
```

- [ ] **Step 3: Default it off.** In `DEFAULT_SETTINGS`, after `hideUi: false,`:

```ts
  mergeRejoins: false,
```

- [ ] **Step 4: Typecheck.** Run: `npm run typecheck` — Expected: clean (no usages yet).

- [ ] **Step 5: Commit.**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add Meeting.visits and Settings.mergeRejoins"
```

---

## Task 2: Pure merge module

**Files:**
- Create: `src/background/merge.ts`
- Test: `tests/merge.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `tests/merge.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { MERGE_GAP_MS, meetCodeFromUrl, mergeMeetings, shouldMerge } from "../src/background/merge"
import type { Meeting } from "../src/shared/types"

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    platform: "meet",
    title: "Daily",
    startedAt: "2026-06-30T10:00:00.000Z",
    endedAt: "2026-06-30T10:30:00.000Z",
    isPrivate: false,
    transcript: [],
    chat: [],
    participants: [],
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    ...over,
  }
}

describe("meetCodeFromUrl", () => {
  it("extracts the code from a join url", () => {
    expect(meetCodeFromUrl("https://meet.google.com/abc-defg-hij")).toBe("abc-defg-hij")
  })
  it("extracts the code ignoring trailing path/query", () => {
    expect(meetCodeFromUrl("https://meet.google.com/abc-defg-hij?authuser=0")).toBe("abc-defg-hij")
  })
  it("returns null for a non-meeting url and for undefined", () => {
    expect(meetCodeFromUrl("https://meet.google.com/lookup/xyz")).toBeNull()
    expect(meetCodeFromUrl(undefined)).toBeNull()
  })
})

describe("shouldMerge", () => {
  const target = meeting({ endedAt: "2026-06-30T10:30:00.000Z" })

  it("merges a sequential same-code visit inside the gap", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" })
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(true)
  })
  it("does not merge past the gap window", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T13:00:00.000Z" }) // +2.5 h
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("merges across midnight when inside the gap (no calendar-day rule)", () => {
    const lateTarget = meeting({ startedAt: "2026-06-30T23:40:00.000Z", endedAt: "2026-06-30T23:55:00.000Z" })
    const incoming = meeting({ id: "m2", startedAt: "2026-07-01T00:05:00.000Z", endedAt: "2026-07-01T00:20:00.000Z" })
    expect(shouldMerge(lateTarget, incoming, MERGE_GAP_MS)).toBe(true)
  })
  it("does not merge a different code", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" })
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("does not merge across differing privacy (privacy invariant)", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", isPrivate: true })
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("does not merge an overlapping (concurrent) visit", () => {
    const incoming = meeting({ id: "m2", startedAt: "2026-06-30T10:20:00.000Z" }) // before target ended
    expect(shouldMerge(target, incoming, MERGE_GAP_MS)).toBe(false)
  })
  it("does not merge when a url is missing or platform is not meet", () => {
    expect(shouldMerge(meeting({ meetingUrl: undefined }), meeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z" }), MERGE_GAP_MS)).toBe(false)
    expect(shouldMerge(target, meeting({ id: "m2", platform: "zoom", startedAt: "2026-06-30T10:35:00.000Z" }), MERGE_GAP_MS)).toBe(false)
  })
})

describe("mergeMeetings", () => {
  const target = meeting({
    id: "m1",
    startedAt: "2026-06-30T10:00:00.000Z",
    endedAt: "2026-06-30T10:30:00.000Z",
    transcript: [{ speaker: "A", startedAt: "2026-06-30T10:05:00.000Z", text: "one" }],
    participants: ["Ada", "Grace"],
  })
  const incoming = meeting({
    id: "m2",
    startedAt: "2026-06-30T10:35:00.000Z",
    endedAt: "2026-06-30T11:00:00.000Z",
    transcript: [{ speaker: "B", startedAt: "2026-06-30T10:40:00.000Z", text: "two" }],
    participants: ["Grace", "Linus"],
  })

  it("keeps target identity, extends endedAt, concatenates body, unions participants", () => {
    const m = mergeMeetings(target, incoming)
    expect(m.id).toBe("m1")
    expect(m.startedAt).toBe("2026-06-30T10:00:00.000Z")
    expect(m.endedAt).toBe("2026-06-30T11:00:00.000Z")
    expect(m.transcript.map(u => u.text)).toEqual(["one", "two"])
    expect(m.participants).toEqual(["Ada", "Grace", "Linus"])
  })

  it("synthesizes both visit spans on the first merge", () => {
    const m = mergeMeetings(target, incoming)
    expect(m.visits).toEqual([
      { startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:30:00.000Z" },
      { startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" },
    ])
  })

  it("appends a third visit incrementally", () => {
    const merged = mergeMeetings(target, incoming)
    const third = meeting({ id: "m3", startedAt: "2026-06-30T11:10:00.000Z", endedAt: "2026-06-30T11:20:00.000Z" })
    const m = mergeMeetings(merged, third)
    expect(m.visits).toHaveLength(3)
    expect(m.endedAt).toBe("2026-06-30T11:20:00.000Z")
  })
})
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/merge.test.ts` — Expected: FAIL (cannot resolve `../src/background/merge`).

- [ ] **Step 3: Implement `src/background/merge.ts`.**

```ts
import type { Meeting } from "../shared/types"

// Two visits of the same Meet code merge only when the second starts within this
// window of the first's end. 2 h comfortably covers "I dropped, stepped away, and
// rejoined the ongoing call" while a daily recurring meeting (~22 h apart) is
// nowhere near it. Gap-only (no calendar-day rule) is correct across midnight.
export const MERGE_GAP_MS = 2 * 60 * 60 * 1000

// The Meet code (abc-defg-hij) carried in a meeting's join url. null when absent
// or not that shape (e.g. a /lookup link), which disables merging for it.
export function meetCodeFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i)
  return m ? m[1].toLowerCase() : null
}

// True when `incoming` is a sequential rejoin of the same meeting as `target`:
// same Meet code, same privacy (never fold private into public or vice versa),
// and starting after target ended but within gapMs. A negative gap means the
// visits overlapped (two simultaneous tabs) — not merged, which avoids tail dedup.
export function shouldMerge(target: Meeting, incoming: Meeting, gapMs: number): boolean {
  if (target.platform !== "meet" || incoming.platform !== "meet") return false
  if (target.isPrivate !== incoming.isPrivate) return false
  const code = meetCodeFromUrl(target.meetingUrl)
  const incomingCode = meetCodeFromUrl(incoming.meetingUrl)
  if (code === null || incomingCode === null || code !== incomingCode) return false
  const gap = Date.parse(incoming.startedAt) - Date.parse(target.endedAt)
  return gap >= 0 && gap <= gapMs
}

// Fold `incoming` into `target`, returning a new Meeting. Identity/title/filename
// inputs come from target (so the file overwrites in place); endedAt advances to
// incoming's; body arrays concatenate (flattenTimeline re-sorts by time on
// render); participants union; visit spans accumulate. The first merge synthesizes
// target's own span so `visits` always describes every visit.
export function mergeMeetings(target: Meeting, incoming: Meeting): Meeting {
  const targetVisits = target.visits ?? [{ startedAt: target.startedAt, endedAt: target.endedAt }]
  return {
    ...target,
    endedAt: incoming.endedAt,
    transcript: [...target.transcript, ...incoming.transcript],
    chat: [...target.chat, ...incoming.chat],
    rawVersions: [...(target.rawVersions ?? []), ...(incoming.rawVersions ?? [])],
    notes: [...(target.notes ?? []), ...(incoming.notes ?? [])],
    participants: [...new Set([...target.participants, ...incoming.participants])],
    visits: [...targetVisits, { startedAt: incoming.startedAt, endedAt: incoming.endedAt }],
  }
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/merge.test.ts` — Expected: PASS (all cases).

- [ ] **Step 5: Commit.**

```bash
git add src/background/merge.ts tests/merge.test.ts
git commit -m "feat(merge): pure meeting identity + merge logic"
```

---

## Task 3: Atomic commit-or-merge in the store

**Files:**
- Modify: `src/background/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/store.test.ts` (add `commitFinalizedMeeting` to the import from `../src/background/store`, and the chrome-mock import + setup if not present). The existing file imports only pure helpers, so add the chrome fake:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeChromeMock, type ChromeMock } from "./helpers/chrome-mock"
import { appendWithRetention, commitFinalizedMeeting, enqueue, listMeetings } from "../src/background/store"
import type { Meeting } from "../src/shared/types"

// ...keep the existing makeMeeting + appendWithRetention/enqueue describes...

function meetMeeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1", platform: "meet", title: "Daily",
    startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:30:00.000Z",
    isPrivate: false, transcript: [], chat: [], participants: [],
    meetingUrl: "https://meet.google.com/abc-defg-hij", ...over,
  }
}

describe("commitFinalizedMeeting", () => {
  let chrome: ChromeMock
  beforeEach(() => {
    chrome = makeChromeMock()
    ;(globalThis as unknown as { chrome: ChromeMock }).chrome = chrome
  })
  afterEach(() => { delete (globalThis as unknown as { chrome?: ChromeMock }).chrome })

  it("appends a fresh meeting when nothing matches", async () => {
    const { meeting, merged } = await commitFinalizedMeeting(meetMeeting(), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    expect(merged).toBe(false)
    expect(meeting.id).toBe("m1")
    expect(await listMeetings()).toHaveLength(1)
  })

  it("merges a sequential same-code visit in place (one entry, visits=2)", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    const { meeting, merged } = await commitFinalizedMeeting(
      meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    expect(merged).toBe(true)
    expect(meeting.id).toBe("m1") // target identity preserved
    const all = await listMeetings()
    expect(all).toHaveLength(1)
    expect(all[0].visits).toHaveLength(2)
  })

  it("does not merge when mergeEnabled is false", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: false, gapMs: 7_200_000 }, 30)
    await commitFinalizedMeeting(meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z" }), { mergeEnabled: false, gapMs: 7_200_000 }, 30)
    expect(await listMeetings()).toHaveLength(2)
  })

  it("does not merge a different code", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    await commitFinalizedMeeting(
      meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    expect(await listMeetings()).toHaveLength(2)
  })

  it("merges into the most recent same-code visit even when another meeting is interleaved", async () => {
    await commitFinalizedMeeting(meetMeeting({ id: "m1" }), { mergeEnabled: true, gapMs: 7_200_000 }, 30)
    await commitFinalizedMeeting(
      meetMeeting({ id: "other", startedAt: "2026-06-30T10:31:00.000Z", endedAt: "2026-06-30T10:32:00.000Z", meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    const { merged } = await commitFinalizedMeeting(
      meetMeeting({ id: "m2", startedAt: "2026-06-30T10:35:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" }),
      { mergeEnabled: true, gapMs: 7_200_000 }, 30,
    )
    expect(merged).toBe(true)
    const all = await listMeetings()
    expect(all).toHaveLength(2) // m1(+m2) and "other"
    expect(all.find(m => m.id === "m1")!.visits).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/store.test.ts` — Expected: FAIL (`commitFinalizedMeeting` not exported).

- [ ] **Step 3: Implement.** In `src/background/store.ts`, add the import at the top:

```ts
import { mergeMeetings, shouldMerge } from "./merge"
```

and add the function (place after `addMeeting`):

```ts
// Atomically commit a finalized meeting: either fold it into the most recent
// mergeable same-code visit (when merging is on) or append it with retention.
// The read-decide-write runs inside one enqueue critical section so two tabs
// finalizing at once cannot race a read-then-write. Returns the stored meeting
// (the merge target's identity when merged, else the incoming one).
export function commitFinalizedMeeting(
  incoming: Meeting,
  opts: { mergeEnabled: boolean; gapMs: number },
  limit: number,
): Promise<{ meeting: Meeting; merged: boolean }> {
  return enqueue(async () => {
    const meetings = await listMeetings()
    if (opts.mergeEnabled) {
      // Scan newest-first; the first mergeable candidate is the most recent same
      // -code visit within the gap (older ones only have a larger gap).
      for (let i = meetings.length - 1; i >= 0; i--) {
        if (shouldMerge(meetings[i], incoming, opts.gapMs)) {
          const merged = mergeMeetings(meetings[i], incoming)
          const next = meetings.slice()
          next[i] = merged
          await setLocal({ meetings: next })
          return { meeting: merged, merged: true }
        }
      }
    }
    await setLocal({ meetings: appendWithRetention(meetings, incoming, limit) })
    return { meeting: incoming, merged: false }
  })
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/store.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/background/store.ts tests/store.test.ts
git commit -m "feat(store): commitFinalizedMeeting (atomic commit-or-merge)"
```

---

## Task 4: Wire merge into `finalizeSession`

**Files:**
- Modify: `src/background/sessions.ts`
- Test: `tests/sessions.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/sessions.test.ts` a new describe (inside the file, reusing its `chrome`/`makeSession`/`oneUtterance`). Add `import type { Meeting } from "../src/shared/types"` if not already present (the file imports `ActiveSession, Meeting`).

> **Why pre-seed the target instead of finalizing two visits?** `finalizeSession` stamps `endedAt = new Date()` (real wall-clock), which a test cannot control. `shouldMerge`'s gap is `incoming.startedAt − target.endedAt`. So we seed visit 1 as an already-finalized `Meeting` with **fixed** `endedAt`, then finalize only visit 2 with a **fixed** `startedAt` 5 min later — the gap is fully deterministic; visit 2's real-time `endedAt` does not enter the gap check. (The precise gap-window math is covered deterministically in Tasks 2–3.)

```ts
describe("finalizeSession — merge rejoined visits", () => {
  function withMerge() {
    chrome.storageSync["settings"] = { mergeRejoins: true }
  }
  // An already-finalized visit-1 meeting sitting in history, same code as makeSession.
  function seedVisit1(over: Partial<Meeting> = {}): Meeting {
    const m: Meeting = {
      id: "m1", platform: "meet", title: "Daily",
      startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:30:00.000Z",
      isPrivate: false, transcript: [{ speaker: "A", startedAt: "2026-06-30T10:05:00.000Z", text: "one" }],
      chat: [], participants: ["Ada"], meetingUrl: "https://meet.google.com/abc-defg-hij", ...over,
    }
    chrome._store["meetings"] = [m]
    return m
  }

  it("merges a sequential same-code visit into the seeded meeting (mergeRejoins on)", async () => {
    withMerge()
    seedVisit1()
    chrome._store["session_7"] = makeSession({
      transcript: [{ speaker: "B", startedAt: "2026-06-30T10:36:00.000Z", text: "two" }],
      startedAt: "2026-06-30T10:35:00.000Z",
    })
    await finalizeSession(7)

    const meetings = chrome._store["meetings"] as Meeting[]
    expect(meetings).toHaveLength(1)
    expect(meetings[0].id).toBe("m1") // target identity preserved
    expect(meetings[0].visits).toHaveLength(2)
    expect(meetings[0].transcript.map(u => u.text)).toEqual(["one", "two"])
  })

  it("keeps visits separate when mergeRejoins is off (default)", async () => {
    seedVisit1()
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, startedAt: "2026-06-30T10:35:00.000Z" })
    await finalizeSession(7)
    expect((chrome._store["meetings"] as Meeting[])).toHaveLength(2)
  })

  it("does not merge a private visit into a public one", async () => {
    withMerge()
    seedVisit1({ isPrivate: false })
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, startedAt: "2026-06-30T10:35:00.000Z", isPrivate: true })
    await finalizeSession(7)
    expect((chrome._store["meetings"] as Meeting[])).toHaveLength(2)
  })

  it("pending export tracks the merged (target) id, not the discarded incoming one", async () => {
    withMerge()
    seedVisit1()
    chrome._store["session_7"] = makeSession({ transcript: oneUtterance, startedAt: "2026-06-30T10:35:00.000Z" })
    const r = await finalizeSession(7)
    expect(r!.meeting!.id).toBe("m1")
    expect(await listPendingExports()).toEqual(["m1"])
  })
})
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/sessions.test.ts` — Expected: FAIL (merge not wired; two meetings instead of one).

- [ ] **Step 3: Implement.** In `src/background/sessions.ts`:

Change the store import line:

```ts
import { addMeeting, addPendingExport, enqueue } from "./store"
```

to:

```ts
import { addPendingExport, commitFinalizedMeeting, enqueue } from "./store"
import { MERGE_GAP_MS } from "./merge"
```

Then in `finalizeSession`, replace:

```ts
    await addMeeting(meeting, settings.retentionLimit)
    // Mark it for export BEFORE removing the session key / returning, so a crash
    // before the caller's download still leaves a trail for SW-start recovery.
    await addPendingExport(meeting.id)
    await removeLocal(sessionKey(tabId))
    // Untrack only after the session key is gone — a failed finalization must
    // keep the tab tracked so the update-deferral guard still sees it.
    await untrackTab(tabId)
    return { meeting, debug, title: session.title, startedAt: session.startedAt, isPrivate: session.isPrivate }
```

with:

```ts
    // Commit to history — folding into a prior visit of the same meeting when the
    // user opted in (mergeRejoins). `stored` carries the merge target's identity
    // when merged, so the .md overwrites in place; otherwise it is this meeting.
    const { meeting: stored } = await commitFinalizedMeeting(
      meeting,
      { mergeEnabled: settings.mergeRejoins, gapMs: MERGE_GAP_MS },
      settings.retentionLimit,
    )
    // Mark it for export BEFORE removing the session key / returning, so a crash
    // before the caller's download still leaves a trail for SW-start recovery.
    await addPendingExport(stored.id)
    await removeLocal(sessionKey(tabId))
    // Untrack only after the session key is gone — a failed finalization must
    // keep the tab tracked so the update-deferral guard still sees it.
    await untrackTab(tabId)
    // meeting (the .md) is `stored`; title/startedAt stay the incoming visit's so
    // the per-visit debug log keeps its own name (debug logs are not merged).
    return { meeting: stored, debug, title: session.title, startedAt: session.startedAt, isPrivate: session.isPrivate }
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/sessions.test.ts` — Expected: PASS (new + all existing cases).

- [ ] **Step 5: Commit.**

```bash
git add src/background/sessions.ts tests/sessions.test.ts
git commit -m "feat(sessions): fold rejoined visits into one meeting at finalize"
```

---

## Task 5: Overwrite the file for merged meetings

**Files:**
- Modify: `src/background/export.ts`
- Test: `tests/export.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/export.test.ts` inside the `downloadMeeting` describe (or a new one):

```ts
describe("downloadMeeting — conflictAction by visit count", () => {
  it("a single-visit meeting uniquifies (never overwrites a sibling)", async () => {
    await downloadMeeting(meeting({}))
    expect(chrome._downloads[0].conflictAction).toBe("uniquify")
  })

  it("a merged meeting (visits > 1) overwrites its own growing file", async () => {
    await downloadMeeting(meeting({
      visits: [
        { startedAt: "2026-06-18T10:00:00.000Z", endedAt: "2026-06-18T10:30:00.000Z" },
        { startedAt: "2026-06-18T10:40:00.000Z", endedAt: "2026-06-18T11:00:00.000Z" },
      ],
    }))
    expect(chrome._downloads[0].conflictAction).toBe("overwrite")
  })
})
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/export.test.ts` — Expected: FAIL (still "uniquify" for the merged case).

- [ ] **Step 3: Implement.** In `src/background/export.ts`, in `downloadMeeting`, change the `chrome.downloads.download` call's `conflictAction`:

```ts
  await chrome.downloads.download({
    url,
    filename: `${folder}/${meetingFileName(meeting)}`,
    // A merged meeting (visits > 1) rewrites the same file it produced on the
    // first visit (startedAt + title are preserved, so the name is identical).
    // A single-visit meeting still uniquifies so it never clobbers a sibling.
    conflictAction: (meeting.visits?.length ?? 0) > 1 ? "overwrite" : "uniquify",
  })
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/export.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/background/export.ts tests/export.test.ts
git commit -m "feat(export): overwrite the file in place for merged meetings"
```

---

## Task 6: Visit separators in the saved file

**Files:**
- Modify: `src/background/format.ts`
- Test: `tests/format.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/format.test.ts` (it already imports `formatMeetingText` and has a meeting factory — reuse whichever helper the file defines; the snippet below builds a literal meeting inline to be self-contained):

```ts
describe("formatMeetingText — visit separators", () => {
  const merged = {
    id: "m1", platform: "meet" as const, title: "Daily",
    startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T11:00:00.000Z",
    isPrivate: false,
    transcript: [
      { speaker: "A", startedAt: "2026-06-30T10:05:00.000Z", text: "before" },
      { speaker: "B", startedAt: "2026-06-30T10:45:00.000Z", text: "after" },
    ],
    chat: [], participants: [],
    visits: [
      { startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:30:00.000Z" },
      { startedAt: "2026-06-30T10:40:00.000Z", endedAt: "2026-06-30T11:00:00.000Z" },
    ],
  }

  it("emits one Visit 2 separator before the first post-rejoin entry", () => {
    const out = formatMeetingText(merged)
    const sepCount = (out.match(/^## Visit 2 · rejoined /gm) ?? []).length
    expect(sepCount).toBe(1)
    // separator sits between the two turns
    expect(out.indexOf("before")).toBeLessThan(out.indexOf("## Visit 2"))
    expect(out.indexOf("## Visit 2")).toBeLessThan(out.indexOf("after"))
  })

  it("emits no separator for a single-visit meeting (output unchanged)", () => {
    const single = { ...merged, visits: undefined }
    expect(formatMeetingText(single)).not.toContain("## Visit")
  })
})
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/format.test.ts` — Expected: FAIL (no `## Visit 2` emitted).

- [ ] **Step 3: Implement.** In `src/background/format.ts`, inside `formatMeetingText`, replace the timeline loop header. Change:

```ts
  const lines: string[] = [...fm, "", `# ${inlineText(meeting.title)}`, ""]
  for (const entry of flattenTimeline(meeting.transcript, meeting.chat, meeting.notes)) {
```

to:

```ts
  const lines: string[] = [...fm, "", `# ${inlineText(meeting.title)}`, ""]
  // Visit separators: for a merged meeting, each visit after the first has a
  // rejoin anchor. Before the first timeline entry at/after an anchor, emit a
  // heading (a `while` drains any anchors a single entry jumps past). Built only
  // from our own timestamps — no untrusted text, so injection-safety is intact.
  const visitAnchors = (meeting.visits ?? []).slice(1).map(v => v.startedAt)
  let visitPtr = 0
  for (const entry of flattenTimeline(meeting.transcript, meeting.chat, meeting.notes)) {
    while (visitPtr < visitAnchors.length && visitAnchors[visitPtr] <= entry.at) {
      const anchor = visitAnchors[visitPtr]
      lines.push(`## Visit ${visitPtr + 2} · rejoined ${clockLabel(anchor)} · +${elapsedLabel(meeting.startedAt, anchor)}`, "")
      visitPtr++
    }
```

(Leave the rest of the loop body and the closing brace exactly as they are.)

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/format.test.ts` — Expected: PASS (new + all existing format cases unchanged).

- [ ] **Step 5: Commit.**

```bash
git add src/background/format.ts tests/format.test.ts
git commit -m "feat(format): render visit separators in merged meetings"
```

---

## Task 7: Options toggle

**Files:**
- Modify: `public/options.html`
- Modify: `src/pages/options/options.ts`

- [ ] **Step 1: Add the checkbox to the HTML.** In `public/options.html`, inside the `Advanced` `<section>`, after the caption-alternatives `<label>`/`hint` pair (before the debug-log label), add:

```html
      <label class="row">
        <span>Merge rejoined visits into one file</span>
        <input type="checkbox" id="merge-rejoins">
      </label>
      <p class="hint">Off by default. If you accidentally leave and rejoin the same meeting within a couple of hours, fold the visits into a single .md instead of one file per visit.</p>
```

- [ ] **Step 2: Wire it in `options.ts`.** Add the element handle near the others (after `captionAlternatives`):

```ts
const mergeRejoins = document.querySelector<HTMLInputElement>("#merge-rejoins")!
```

In `init()`, after `captionAlternatives.checked = settings.captionAlternatives`:

```ts
  mergeRejoins.checked = settings.mergeRejoins
```

Add a change listener near the others:

```ts
mergeRejoins.addEventListener("change", () => {
  void saveSettings({ mergeRejoins: mergeRejoins.checked })
})
```

- [ ] **Step 3: Typecheck + build.** Run: `npm run typecheck && npm run build` — Expected: clean; `dist/options.js` rebuilt.

- [ ] **Step 4: Commit.**

```bash
git add public/options.html src/pages/options/options.ts
git commit -m "feat(options): toggle to merge rejoined visits"
```

---

## Task 8: History visit count

**Files:**
- Modify: `src/pages/history/history.ts`

- [ ] **Step 1: Annotate the title cell.** In `render`, replace the row build:

```ts
    row.append(
      cell(new Date(meeting.startedAt).toLocaleString()),
      cell(meeting.title),
      cell(String(meeting.transcript.length)),
      cell(meeting.isPrivate ? "private" : "—"),
      actionsCell(meeting),
    )
```

with:

```ts
    const visitCount = meeting.visits?.length ?? 0
    const title = visitCount > 1 ? `${meeting.title} · ${visitCount} visits` : meeting.title
    row.append(
      cell(new Date(meeting.startedAt).toLocaleString()),
      cell(title),
      cell(String(meeting.transcript.length)),
      cell(meeting.isPrivate ? "private" : "—"),
      actionsCell(meeting),
    )
```

(`cell` uses `textContent`, so the suffix stays XSS-safe.)

- [ ] **Step 2: Typecheck + build.** Run: `npm run typecheck && npm run build` — Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add src/pages/history/history.ts
git commit -m "feat(history): show visit count for merged meetings"
```

---

## Task 9: Docs

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Changelog.** Add an `## Unreleased` section at the top of `CHANGELOG.md` (or extend the existing one if present) with:

```markdown
### Added
- Optional merging of rejoined visits: if you accidentally leave and rejoin the
  same meeting within ~2 hours, the visits can be folded into a single `.md`
  (off by default; enable "Merge rejoined visits into one file" in Settings).
  Visit boundaries are marked in the file with a `## Visit N · rejoined …` heading.
```

- [ ] **Step 2: Readme.** In `README.md`, wherever the settings/options are listed, add a bullet for the new toggle, mirroring the hint text. (If there is no settings list, add a short note under the existing feature list.)

- [ ] **Step 3: Full gate.** Run: `npm run typecheck && npm test && npm run build` — Expected: all green; note the new total test count.

- [ ] **Step 4: Commit.**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog and readme for merge-rejoined-visits"
```

---

## Task 10: Release (manual)

> `npm run release` is blocked by the local auto-mode classifier; bump by hand.

- [ ] **Step 1: Decide the bump.** Features since v1.8.0 ⇒ **minor** → `1.9.0` (confirm against `package.json`).
- [ ] **Step 2: Bump in lockstep.** Set `"version": "1.9.0"` in both `package.json` and `public/manifest.json`.
- [ ] **Step 3: Move the changelog `Unreleased` section under `## 1.9.0 - 2026-06-30`.**
- [ ] **Step 4: Commit + tag.**

```bash
git add package.json public/manifest.json CHANGELOG.md
git commit -m "chore(release): v1.9.0"
git tag v1.9.0
```

- [ ] **Step 5: Rebuild dist with the new stamp.** Run: `npm run build`.
- [ ] **Step 6: Push the tag explicitly** (needs VPN + 1Password SSH socket):

```bash
git push origin v1.9.0
```

(Coordinate the `main` merge of `feat/merge-rejoined-visits` separately; if `feat/rtc-media-end-signal` lands first, re-run `npm test` on the merged tree before tagging.)

---

## Notes for the implementer

- Run the **whole** suite (`npm test`) after Task 6 and again at Task 9 — the merge touches shared modules (`format.ts`, `sessions.ts`) and you want the existing hostile-input / lifecycle tests to stay green, not just the new files.
- Do **not** touch `src/content/**` — the capture path is intentionally untouched, and that is also where the parallel #6/O5 work lives.
- Invariants to keep green: zero network (no fetch/XHR), XSS-safe (`textContent` only), privacy (the `isPrivate` guard in `shouldMerge`), injection-safety (separator is timestamp-only).
