# Output format & filename polish — design

> Status: approved 2026-06-29. Refines the v2 `.md` output (ROADMAP #4).
> Scope: rendering + a one-line data carry + one new setting + tests. Single
> implementation plan, TDD. No multi-agent workflow.

## Goal

Make the saved `.md` read nicely for a human opening it, without losing
structure or the injection-safety invariant. Add the meeting join link (the data
is already captured but never reaches the file).

## Decisions (locked)

### 1. Body → human Markdown prose

Replace the `[tN] Speaker  <full-ISO> (+elapsed)` / body-line grid with:

```markdown
# Sprint sync

**Alice** · 10:01 · +01:00
> Hello everyone

**Bob** · _chat_ · 10:05 · +05:00
> see link

**Note** · 10:06 · +06:00
> follow up with Ada
```

- A visible `# {title}` opens the body (document heading; "human on top").
- Each turn: `**{speaker}** · {HH:MM} · +{elapsed}` then the text as a blockquote
  (`> ...`). The per-turn **full ISO is dropped** — absolute time lives in the
  front matter; a local `HH:MM` wall-clock plus `+elapsed` is enough on the line.
- Tags as italic segments after the speaker:
  - chat: `**Bob** · _chat_ · …`
  - unresolved speaker: `**Speaker 4** · _unresolved_ · …`
- Notes: `**Note** · {HH:MM} · +{elapsed}` then `> {text}`.
- Bookmark (empty note): `**Bookmark** · {HH:MM} · +{elapsed}` — header only, no
  body line.
- The visible `[tN]` counter is removed (no machine consumer reads it today; the
  timeline order is the addressing).
- Blank line between turns.

New helper `clockLabel(iso)` → local `HH:MM` (reuses the `isoLocal` machinery for
the local-time conversion). `isoLocal` / `elapsedLabel` stay.

### 2. Front matter → human fields only; provenance to a comment

Visible YAML front matter keeps only human-relevant fields, in this order:
`title`, `url`, `language` (if present), `timezone`, `started`, `ended`,
`recorder` (if present), `participants` (if non-empty).

`url` is the full join link `https://meet.google.com/{code}`, emitted via
`yamlScalar` (escaped like every free-text field). Rendered only when present.

The machine/provenance triple moves out of the visible block into a single HTML
comment immediately after the closing `---`:

```
<!-- Plática Notes {VERSION} ({COMMIT}) · schema platica-notes-transcript/3 · source {platform-source} -->
```

- `schema` bumps **/2 → /3** (the body grammar changed — honest discriminator).
  Still greppable for any future re-import, just not in the human block.
- `source` keeps the existing `PLATFORM_SOURCES` mapping, rendered in the comment.
- `generator` (version + commit) was the only machine-noise field in the visible
  block; it now lives in this comment too.

### 3. Caption alternatives (`alt:`) → setting, default on

New `Settings.captionAlternatives: boolean`, default `true`. Meet drops 20-26% of
words from final captions, so the alternatives are the safety net against lost
words and are kept on by default; a user can turn them off for a cleaner file.

When **on**, alternatives render as a subordinate line inside the same blockquote:

```markdown
**Bob** · 10:02 · +02:00
> Hi Alice
> ↳ _alt:_ Hi Alis
```

`formatMeetingText` gains an options arg: `formatMeetingText(meeting, opts?: {
alternatives?: boolean })`. `downloadMeeting` passes
`{ alternatives: settings.captionAlternatives }` (it already loads settings).
A new checkbox on the options page controls the setting.

### 4. Filename — title-first, kept; minor cleanup

Pattern stays `{sanitized title} {YYYY-MM-DD HH-MM}.md` with Chrome
`conflictAction: "uniquify"`. `sanitizeFileName` gains: collapse runs of `_` to a
single `_`, then re-trim. No date-first reordering; no private-folder title
redaction (the private folder is the boundary).

## Safety hardening (found in passing)

The speaker name currently reaches the turn header **without** `inlineText`
(`format.ts:138`) — only the body is collapsed. A name like `"Alice\n[t99] CEO"`
could forge a turn; the new format makes the speaker even more structural
(`**Name** ·`). Fix: run **speaker/sender and the H1 title through `inlineText`**
as well.

Invariant restated: file safety is enforced by `inlineText` (newline collapse) +
`yamlScalar` (front-matter escaping), **not** by the header's visual shape. Every
body line carries `> `, so a chat message can never spawn a new header line. A
forged-via-speaker-name test is added.

## Data carry

`Meeting` gains `meetingUrl?: string`. At finalize (`sessions.ts`),
`meetingUrl = session.path && session.platform === "meet"
  ? \`https://meet.google.com${session.path}\` : undefined`.
`ActiveSession.path` already persists across reload/orphan recovery, so no new
capture path and no change to the zero-egress invariant — we write a string we
already hold.

**Privacy:** the join link is written into private-meeting files too. The private
folder is the boundary; egress stays zero. Deliberate choice (not redacted).

## Touched files

| File | Change |
|---|---|
| `shared/types.ts` | `Meeting.meetingUrl?`; `Settings.captionAlternatives` + `DEFAULT_SETTINGS` |
| `background/sessions.ts` | set `meetingUrl` from `session.path` (meet only) |
| `background/format.ts` | new body renderer; `clockLabel`; front matter (url, comment, schema/3); H1; `inlineText` on speaker/title; alt gated by opts; `sanitizeFileName` `_` collapse |
| `background/export.ts` | pass `{ alternatives }` into `formatMeetingText` |
| `tests/format.test.ts` | rewrite header-shape assertions; **keep injection tests green**; add: `url` field, alt opt-in on/off, forge-via-speaker-name, `_`-collapse |
| options page (html + ts) | checkbox for `captionAlternatives` |

## Invariants preserved

- Zero network egress (no new request; URL is local string).
- XSS-safe DOM unchanged (this is file text, not panel DOM); no `innerHTML`.
- Injection-safety: `inlineText` + `yamlScalar` kept and extended to speaker/title;
  injection tests stay green.
- Privacy flag honored on every output path (folder routing unchanged).

## Out of scope

Speaker-grouped/collapsible blocks, date-first filenames, private-title
redaction, per-N-minute timecodes (roadmap backlog).
