# Merge repeated visits of the same meeting — design

> **Update 2026-06-30 (v1.12.0):** the two defaults below were revisited after
> shipping — `mergeRejoins` is now **on by default** (the feature only helps if
> it's discovered, and merging is reversible), and `MERGE_GAP_MS` is **~40 min**
> (not 2 h), short enough that a persistent room reused for a later call is not
> merged by mistake. The rest of the design stands.
>
> Status: approved 2026-06-30. Implements ROADMAP #5.
> Scope: a post-commit merge step in the background, one new setting, a `visits`
> field on `Meeting`, a render separator, a history annotation, and tests. Single
> implementation plan, TDD.
>
> **Coordination:** ROADMAP #6 (end/rejoin/nav scenarios) is in flight in another
> session and also touches `src/background/sessions.ts` and `store.ts`. This design
> is deliberately **additive** there (a new branch in `finalizeSession`, a new
> store function, no edits to existing finalize/recovery logic). Reconcile at code
> time before merging either branch.

## Goal

When a user accidentally leaves and rejoins **the same** meeting — same tab, or a
different tab — optionally fold the visits into **one** `.md` file instead of N.
Today every visit is its own session → its own `Meeting` → its own file
(per-visit by design). Accidental drops fragment one logical sitting across files.

## The two hard parts

1. **Identity.** A daily recurring meeting reuses the **same Meet code and title
   every day**, so "same code → merge" would glue Monday onto Tuesday. The merge
   key is **code + temporal proximity**, never code alone.
2. **The file is already on disk.** Auto-download happens at each visit's
   finalize. To end with one file we must decide to merge *before* writing the
   second file, and rewrite the first file in place.

## Architecture (locked): merge at finalize, on the meeting store

All merge logic runs inside the background's `finalizeSession`, **after** the
visit is already committed to the `meetings` store. The capture path in
`src/content/platforms/meet.ts` (reload-resume, the stale-session finalize, the
drain-tail grace) and the per-`tabId` session key (`session_<tabId>`) are **not
touched**.

Why this shape:

- **Preserves the 1.6.3 data-loss guarantee.** Each visit still finalizes
  independently and lands in the store first. Merge is an additive transform on
  already-safe data. If merge logic throws, the system degrades to today's
  behaviour (N separate files), never to lost data.
- **Cross-tab for free.** Two tabs with the same code each finalize
  independently; the *second* finalize finds the first `Meeting` and merges into
  it. No live cross-tab coordination, no two content scripts writing one key.
- **Small blast radius.** `sessions.ts`, `store.ts`, `export.ts`, `format.ts`,
  `types.ts`, options page, history page. Pure logic isolated in a new
  `src/background/merge.ts`.

Rejected alternatives: a meeting-level **live** session (re-keying the active
session off meeting identity) — it rips up the per-`tabId` model that 1.6.3,
orphan recovery, and stale-finalize all depend on, and needs live tab
refcounting; highest risk, collides with #6. A history-only "combined export"
that keeps N files — does not meet the "one file" goal.

## Invariants preserved (do not regress)

- **Zero network egress.** Merge is pure local store + `chrome.downloads`.
- **1.6.3 orphan/stale-session finalize before key overwrite** — untouched; merge
  runs strictly after a visit is committed.
- **Privacy flag honored on every output path** — see the `isPrivate` guard in the
  merge predicate below. Private and non-private visits never merge into one file.
- **XSS-safe DOM / YAML & body injection-safety in `format.ts`** — the visit
  separator is built only from our own timestamps, never from untrusted text.

## Decisions (locked)

### 1. Identity & merge predicate (gap-only)

A visit (`incoming`) merges into an existing `Meeting` (`target`) when **all** of:

- `incoming.platform === "meet"` and a Meet code is derivable from each meeting's
  `meetingUrl`;
- **same code** (`meetCodeFromUrl(target.meetingUrl) === meetCodeFromUrl(incoming.meetingUrl)`,
  both non-null);
- **same `isPrivate`** — *privacy invariant: never fold a private visit into a
  public file or vice versa; differing flags ⇒ keep separate*;
- **sequential within the gap**: `gap = Date.parse(incoming.startedAt) -
  Date.parse(target.endedAt)` satisfies `0 <= gap <= MERGE_GAP_MS`. A negative
  gap means the visits overlapped in time (two simultaneous tabs) — not merged,
  which sidesteps tail-dedup entirely. A gap beyond the window means a separate
  later sitting in the same room — not merged.

`MERGE_GAP_MS = 2 * 60 * 60 * 1000` (**2 hours**), an internal constant (not a UI
setting). Rationale: comfortably covers "I dropped, stepped away, rejoined the
ongoing call" while a daily recurring meeting (~22 h apart) is nowhere near it.

**No calendar-day rule.** Gap alone is strictly better: it is correct across
midnight (23:50 → 00:10 rejoin merges; a same-day rule would wrongly refuse), and
the day boundary adds nothing a 2 h gap does not already enforce against the
daily-recurring case.

**Candidate selection.** The merge target is the **most recent** `Meeting` with
the same code (the last match scanning `meetings` in store order, which is
finalize order). Any earlier same-code meeting has a strictly larger gap, so one
candidate suffices. Merging is **incremental**: visit 3 merges into the
already-merged (1, 2) meeting, with the gap measured from the last visit's end.

`meetCodeFromUrl(url)`: extract `abc-defg-hij` from a `https://meet.google.com/…`
URL via `/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i`; `null` when absent
or not that shape.

### 2. Merge operation (pure)

`mergeMeetings(target: Meeting, incoming: Meeting): Meeting` returns a new
`Meeting`:

| field | value |
|---|---|
| `id` | `target.id` (stable history entry; we replace in place) |
| `startedAt` | `target.startedAt` (stable filename ⇒ overwrite hits the same path) |
| `endedAt` | `incoming.endedAt` (latest) |
| `title`, `language`, `recorder`, `meetingUrl`, `platform`, `isPrivate` | from `target` |
| `transcript`, `chat`, `rawVersions`, `notes` | **concatenation** `target` ++ `incoming` |
| `participants` | **union**, deduped: `[...new Set([...target, ...incoming])]` |
| `visits` | see below |

- Body ordering: `flattenTimeline` re-sorts every entry by `at`, so plain
  concatenation renders chronologically correct without manual interleaving.
- **Participants = cumulative union.** This revisits the earlier "per-visit, not
  cumulative" choice: inside one logical meeting, the union of everyone seen
  across visits is the right attendee list. (`format.ts` already dedups + sorts
  participants for the front matter.)
- **`language` keeps `target`'s** (first visit's). A visit recorded in a different
  caption language is a known minor limitation, not handled in v1.

### 3. `visits` metadata

New optional field on `Meeting`:

```ts
export interface VisitSpan { startedAt: string; endedAt: string } // ISO 8601
// in Meeting:
visits?: VisitSpan[]
```

- A single-visit (never-merged) `Meeting` has **no** `visits` field → fully
  backward compatible; existing stored meetings and all current tests are
  unaffected.
- First merge synthesizes the target's span:
  `targetVisits = target.visits ?? [{ startedAt: target.startedAt, endedAt: target.endedAt }]`,
  then appends `{ startedAt: incoming.startedAt, endedAt: incoming.endedAt }`.
- `visits.length > 1` is therefore the canonical "this is a merged meeting"
  signal, used by both the downloader and the history page.

### 4. One file on disk (overwrite, crash-safe)

`downloadMeeting` chooses `conflictAction` **from the meeting itself**:

```ts
conflictAction: (meeting.visits?.length ?? 0) > 1 ? "overwrite" : "uniquify"
```

- A merged meeting always overwrites at the **same filename** as visit 1 (because
  `startedAt` + `title` are preserved), so visit 2's standalone file is never
  written; the file is rewritten with merged(1..N) content.
- This is intrinsically **crash-safe**: on merge we `addPendingExport(target.id)`;
  if the service worker dies before the download, `recoverPendingExports`
  re-downloads the merged meeting on next start, and `visits.length > 1` again
  yields `overwrite` — no duplicate file.
- **No `downloadId` tracking, no file deletion** (the user-chosen posture: never
  delete or move files the user owns).

Accepted soft edges:

- If the user **moved/renamed** visit 1's file between visits, `overwrite` cannot
  find it; Chrome writes a fresh merged file at the canonical path and the moved
  copy lingers (stale, partial). Mild, rare.
- If visit 1's file was itself **uniquified** at download time (name collision
  with an *unrelated* meeting at the same title+minute), the overwrite targets the
  base name and misses. Astronomically unlikely for sequential visits of the same
  meeting; accepted, not engineered around in v1.

### 5. Visit separator in the saved file

`formatMeetingText` reads `meeting.visits`. Before iterating the flattened
timeline, compute the rejoin anchors `visits.slice(1).map(v => v.startedAt)` and a
pointer into them. While emitting entries in time order, **before** each entry
drain every anchor with `anchor <= entry.at` (a `while` loop, not a single check —
so an entry that jumps past several anchors still emits one separator per crossed
visit), then emit the entry:

```
## Visit {n} · rejoined {HH:MM} · +{elapsed}
```

where `n` is the visit's 1-based number: anchor at sliced-index `j` ⇒ `n = j + 2`
(the first slice element is Visit 2). `HH:MM` is `clockLabel(anchor)`, `+elapsed`
is `elapsedLabel(meeting.startedAt, anchor)`. Any anchors still undrained after the
last entry are not emitted (a visit always has ≥1 entry, since an empty visit
never produces a `Meeting`, so this is not expected in practice).

- No `visits` (or `visits.length <= 1`) ⇒ no separators; output identical to
  today for unmerged meetings.
- Built only from timestamps → no injection surface; the `format.ts`
  `yamlScalar`/`inlineText` invariants and their tests are untouched in spirit.
- Heading level `##` sits above the per-turn `**Name** · …` lines and the `###
  Note`/`### Bookmark` blocks, so visits read as the top structural division.

### 6. Setting & migration

Add to `Settings`:

```ts
/** Fold sequential rejoins of the same meeting (within a 2 h gap) into one .md
 *  file instead of one per visit. Off by default. */
mergeRejoins: boolean
```

`DEFAULT_SETTINGS.mergeRejoins = false`. **Default OFF** (conservative): existing
users — and the downstream LLM pipeline that consumes these files — keep today's
per-visit behaviour until they opt in. `withDefaults` already backfills the field
for existing users, so no explicit migration is needed.

Stored in `chrome.storage.sync` like the rest of `Settings`; read in the
background at finalize. `finalizeSession` already calls `getSettings()` (for
`retentionLimit`), so this adds no extra read.

Options page: one checkbox, "Merge rejoined visits of the same meeting into one
file", wired like the existing setting checkboxes.

### 7. History display

`src/pages/history/history.ts`: when `meeting.visits && meeting.visits.length >
1`, append a ` · {N} visits` suffix to the title cell (via `textContent`, XSS-safe
like the rest of the page). One row per merged meeting (it is one `Meeting` id);
the transcript-count cell already reflects the merged total. Minimal — no grouping
UI.

### 8. Debug logs stay per-visit

The per-visit debug log (named by the incoming visit's `title` + `startedAt`) is
**not** merged. Debug logs are diagnostic, not the product artifact; each visit
keeps its own. `FinalizeResult.title`/`startedAt` therefore stay the *incoming*
visit's values; only `FinalizeResult.meeting` becomes the stored (possibly
merged) meeting.

## Code map

**New — `src/background/merge.ts`** (pure, no `chrome.*`, fully unit-testable):

```ts
export const MERGE_GAP_MS: number
export function meetCodeFromUrl(url: string | undefined): string | null
export function shouldMerge(target: Meeting, incoming: Meeting, gapMs: number): boolean
export function mergeMeetings(target: Meeting, incoming: Meeting): Meeting
```

**`src/background/store.ts`** — add an atomic commit-or-merge that does the
read → decide → write inside one `enqueue` critical section (so two tabs
finalizing concurrently cannot race a read-then-write):

```ts
export function commitFinalizedMeeting(
  incoming: Meeting,
  opts: { mergeEnabled: boolean; gapMs: number },
  limit: number,
): Promise<{ meeting: Meeting; merged: boolean }>
```

Inside `enqueue`: read `meetings`; if `mergeEnabled`, find the last same-code
candidate and test `shouldMerge`; on success build `mergeMeetings(target,
incoming)` and replace it **in place** (preserve array position), else append via
`appendWithRetention`. Returns the stored meeting (merged or `incoming`) and a
`merged` flag. If the candidate fell out of retention between read and now
(implausible inside a 2 h window, ~30 meetings), it simply appends — no merge.
Existing `addMeeting` is kept for tests/back-compat.

**`src/background/sessions.ts`** — in `finalizeSession`, replace
`await addMeeting(meeting, settings.retentionLimit)` with:

```ts
const { meeting: stored } = await commitFinalizedMeeting(
  meeting,
  { mergeEnabled: settings.mergeRejoins, gapMs: MERGE_GAP_MS },
  settings.retentionLimit,
)
await addPendingExport(stored.id)
// …removeLocal(sessionKey)/untrackTab unchanged…
return { meeting: stored, debug, title: session.title, startedAt: session.startedAt, isPrivate: session.isPrivate }
```

No other change to finalize ordering; the orphan-recovery path inherits the merge
because it calls the same `finalizeSession`.

**`src/background/export.ts`** — `conflictAction` selection (decision 4).

**`src/background/format.ts`** — visit separators (decision 5).

**`src/shared/types.ts`** — `VisitSpan`, `Meeting.visits`, `Settings.mergeRejoins`,
`DEFAULT_SETTINGS.mergeRejoins`.

**`src/pages/options/options.{ts,html}`** — the checkbox.

**`src/pages/history/history.ts`** — the visit-count suffix.

## Testing (TDD)

Pure (`tests/merge.test.ts`, new):

- `meetCodeFromUrl`: valid URL, extra path segments, non-meet/`undefined` → null.
- `shouldMerge` matrix: same code in-window → true; gap just over `MERGE_GAP_MS`
  → false; different code → false; **isPrivate mismatch → false**; negative gap
  (overlap) → false; cross-midnight within gap → true; missing `meetingUrl` →
  false; non-meet platform → false.
- `mergeMeetings`: id/startedAt/title/isPrivate from target; endedAt from
  incoming; transcript/chat/notes/rawVersions concatenated; participants unioned
  (no dups); `visits` synthesized on first merge and appended on the second;
  incremental third merge.

Background integration (`tests/sessions.test.ts`, extend; in-memory `chrome.*`
fake): two sequential same-code finalizes with `mergeRejoins: true` → one
`meetings` entry with `visits.length === 2`, merged transcript, one
`pendingExports` entry cleared after deliver; with `mergeRejoins: false` → two
entries; different code → two entries; private + public same code → two entries;
gap beyond window → two entries.

Format (`tests/format.test.ts`, extend): a meeting with `visits.length === 2`
emits exactly one `## Visit 2 · rejoined …` before the first post-rejoin entry; a
meeting with no `visits` emits none (assert current output unchanged); separator
text is timestamp-only (injection-safety unchanged).

Gate: `npm run typecheck`, `npm test`, `npm run build` all green before handing
back.

## Out of scope (v1)

- Tail/overlap dedup for two genuinely-simultaneous tabs (excluded by the
  sequential-only predicate).
- Merging across differing caption languages (keeps first visit's `language`).
- Merging debug logs (stay per-visit).
- Exposing the gap window as a setting (internal constant; YAGNI).
- Un-merging / splitting a merged meeting after the fact.

## Release

Manual (the `npm run release` script is blocked by the local auto-mode
classifier): bump `package.json` + `public/manifest.json` in lockstep, update
`CHANGELOG.md` and `README.md` (new setting + behaviour), commit
`chore(release): vX.Y.Z`, tag, and push the tag explicitly (`git push origin
vX.Y.Z`; needs VPN + 1Password SSH socket). A `feat` ⇒ minor bump.
