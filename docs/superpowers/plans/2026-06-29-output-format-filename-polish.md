# Output format & filename polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the saved `.md` read as human Markdown (H1 + bold-speaker + blockquote body), move machine metadata to a comment, add the meeting join link, gate caption alternatives behind an opt-in setting, and tidy filename sanitisation — without regressing injection-safety.

**Architecture:** Pure render change in `src/background/format.ts` (already heavily unit-tested), a one-line data carry in `sessions.ts`, two new type fields, an options-page checkbox, and a flag threaded from `export.ts`. TDD throughout; `vitest`.

**Tech Stack:** TypeScript, esbuild, vitest. Run tests with `npm test`, types with `npm run typecheck`.

Spec: `docs/superpowers/specs/2026-06-29-output-format-filename-polish-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | add `Meeting.meetingUrl?`, `Settings.captionAlternatives`, default |
| `src/background/sessions.ts` | derive `meetingUrl` from `session.path` at finalize |
| `src/background/format.ts` | new body/front-matter renderer, `clockLabel`, `FormatOptions`, `sanitizeFileName` `_`-collapse |
| `src/background/export.ts` | pass `{ alternatives }` into `formatMeetingText` |
| `public/options.html` | checkbox markup |
| `src/pages/options/options.ts` | load/save the checkbox |
| `tests/format.test.ts` | rewritten format assertions + new safety/alt tests |
| `tests/sessions.test.ts` | assert `meetingUrl` carry |

---

## Task 1: Type fields + setting default

**Files:**
- Modify: `src/shared/types.ts`
- Test: `tests/storage.test.ts` (default assertion)

- [ ] **Step 1: Write the failing test**

Add to `tests/storage.test.ts` inside the existing top-level `describe` (or a new one):

```ts
import { DEFAULT_SETTINGS } from "../src/shared/types"

describe("captionAlternatives default", () => {
  it("defaults caption alternatives off", () => {
    expect(DEFAULT_SETTINGS.captionAlternatives).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/storage.test.ts`
Expected: FAIL — `captionAlternatives` does not exist on `DEFAULT_SETTINGS`.

- [ ] **Step 3: Add the type fields and default**

In `src/shared/types.ts`, add to the `Meeting` interface (after `language?`):

```ts
  /** Join link of the recorded meeting, e.g. https://meet.google.com/abc-defg-hij. */
  meetingUrl?: string
```

Add to the `Settings` interface (after `debugLog`):

```ts
  /**
   * Emit per-caption ASR alternatives in the saved .md (the `> ↳ _alt:_ …`
   * lines). Off by default — they are a power-user recovery aid, not part of the
   * clean human transcript.
   */
  captionAlternatives: boolean
```

Add to `DEFAULT_SETTINGS` (after `debugLog: false,`):

```ts
  captionAlternatives: false,
```

- [ ] **Step 4: Run test + typecheck**

Run: `npm test -- tests/storage.test.ts && npm run typecheck`
Expected: storage test PASS. Typecheck may now FAIL in `format.ts`/`export.ts`/`sessions.ts` if they read the new fields — that is fine, those are later tasks. If typecheck fails ONLY there, continue.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts tests/storage.test.ts
git commit -m "feat(types): add meetingUrl and captionAlternatives setting"
```

---

## Task 2: `clockLabel` helper

**Files:**
- Modify: `src/background/format.ts`
- Test: `tests/format.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` block at the end of `tests/format.test.ts`, and add `clockLabel` to the import from `../src/background/format`:

```ts
describe("clockLabel", () => {
  it("renders local wall-clock HH:MM with no date or offset", () => {
    expect(clockLabel("2026-06-10T10:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/)
  })

  it("agrees with the local hours/minutes of the instant", () => {
    const d = new Date("2026-06-10T10:05:00.000Z")
    const pad = (n: number) => String(n).padStart(2, "0")
    expect(clockLabel("2026-06-10T10:05:00.000Z")).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/format.test.ts -t clockLabel`
Expected: FAIL — `clockLabel is not exported` / undefined.

- [ ] **Step 3: Implement `clockLabel`**

In `src/background/format.ts`, add after `elapsedLabel` (it reuses the existing `pad2`):

```ts
// Local wall-clock HH:MM for a turn header. The absolute instant lives in the
// front matter (started/ended), so a turn line only needs the clock + elapsed.
export function clockLabel(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/format.test.ts -t clockLabel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/format.ts tests/format.test.ts
git commit -m "feat(format): add clockLabel helper"
```

---

## Task 3: New renderer — body, front matter, comment, alt opt-in, speaker hardening

This rewrites `formatMeetingText` and its test block in one coherent change (the body grammar, front matter, and alt gating are one unit; splitting them leaves the test suite half-migrated).

**Files:**
- Modify: `src/background/format.ts:87-147` (the `formatMeetingText` function)
- Test: `tests/format.test.ts` (replace the `describe("formatMeetingText (v2)")` block)

- [ ] **Step 1: Replace the format test block**

Replace the entire `describe("formatMeetingText (v2)", () => { … })` block in `tests/format.test.ts` with this `v3` block. Keep the `makeMeeting` helper above it unchanged. `formatMeetingText` is already imported.

```ts
describe("formatMeetingText (v3)", () => {
  function frontMatter(text: string): string {
    const end = text.indexOf("\n---", 3)
    return text.slice(0, end)
  }

  it("opens with a human YAML front matter: title, timezone, started, ended", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text.startsWith("---\n")).toBe(true)
    const fm = frontMatter(text)
    expect(fm).toContain('title: "Sprint sync"')
    expect(fm).toContain(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
    expect(fm).toMatch(/started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
    expect(fm).toMatch(/ended: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
  })

  it("moves schema, source and generator out of the human block into a comment", () => {
    const text = formatMeetingText(makeMeeting())
    const fm = frontMatter(text)
    expect(fm).not.toContain("schema:")
    expect(fm).not.toContain("source:")
    expect(fm).not.toContain("generator")
    expect(text).toMatch(
      /<!-- Plática Notes .+ · schema platica-notes-transcript\/3 · source google-meet-live-captions -->/,
    )
  })

  it("renders the meeting url in the front matter when present, omits it when absent", () => {
    const withUrl = frontMatter(formatMeetingText(makeMeeting({ meetingUrl: "https://meet.google.com/abc-defg-hij" })))
    expect(withUrl).toContain('url: "https://meet.google.com/abc-defg-hij"')
    expect(frontMatter(formatMeetingText(makeMeeting()))).not.toContain("url:")
  })

  it("opens the body with an H1 of the meeting title", () => {
    const text = formatMeetingText(makeMeeting())
    expect(text).toContain("\n# Sprint sync\n")
  })

  it("quotes and escapes a title with special characters", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ title: 'a "b": c' })))
    expect(fm).toContain('title: "a \\"b\\": c"')
  })

  it("escapes a newline in a quoted scalar so the front matter stays one field per line", () => {
    const text = formatMeetingText(makeMeeting({ title: "line1\nline2" }))
    expect(text).toContain('title: "line1\\nline2"')
  })

  it("includes language and recorder when present, omits them when absent", () => {
    const withMeta = frontMatter(formatMeetingText(makeMeeting({ language: "ru-RU", recorder: "Alex" })))
    expect(withMeta).toContain('language: "ru-RU"')
    expect(withMeta).toContain('recorder: "Alex"')
    const without = frontMatter(formatMeetingText(makeMeeting()))
    expect(without).not.toContain("language:")
    expect(without).not.toContain("recorder:")
  })

  it("renders participants as a sorted, quoted block list; omits the key when empty", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ participants: ["Charlie", "alice", "Bob"] })))
    expect(fm).toContain('participants:\n  - "alice"\n  - "Bob"\n  - "Charlie"')
    expect(frontMatter(formatMeetingText(makeMeeting()))).not.toContain("participants:")
  })

  it("dedupes participants in the front matter", () => {
    const fm = frontMatter(formatMeetingText(makeMeeting({ participants: ["Bob", "Bob", "alice"] })))
    expect(fm).toContain('participants:\n  - "alice"\n  - "Bob"')
    expect(fm.match(/- "Bob"/g)).toHaveLength(1)
  })

  it("renders a speech turn as bold speaker · clock · elapsed with a blockquote body", () => {
    const text = formatMeetingText(makeMeeting({
      startedAt: "2026-06-10T10:00:00.000Z",
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:09.000Z", text: "Hello everyone" }],
      chat: [],
    }))
    expect(text).toMatch(/\*\*Alice\*\* · \d{2}:\d{2} · \+01:09\n> Hello everyone/)
  })

  it("tags chat turns and interleaves them in time order", () => {
    const text = formatMeetingText(makeMeeting({
      chat: [{ sender: "Bob", sentAt: "2026-06-10T10:05:00.000Z", text: "see link" }],
    }))
    expect(text).toMatch(/\*\*Bob\*\* · _chat_ · \d{2}:\d{2} · \+05:00\n> see link/)
    expect(text.indexOf("see link")).toBeGreaterThan(text.indexOf("Hi Alice"))
  })

  it("marks an unresolved Speaker N label", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Speaker 4", startedAt: "2026-06-10T10:01:00.000Z", text: "yes" }],
      chat: [],
    }))
    expect(text).toMatch(/\*\*Speaker 4\*\* · _unresolved_ · /)
  })

  it("does not mark a chat sender as unresolved even if named like a fallback label", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [{ sender: "Speaker 4", sentAt: "2026-06-10T10:02:00.000Z", text: "hi" }],
    }))
    expect(text).toContain("**Speaker 4** · _chat_ ·")
    expect(text).not.toContain("_unresolved_")
  })

  it("renders a note as a Note turn with its text in a blockquote", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [],
      notes: [{ at: "2026-06-10T10:03:00.000Z", text: "follow up with Ada" }],
    }))
    expect(text).toMatch(/\*\*Note\*\* · \d{2}:\d{2} · \+03:00\n> follow up with Ada/)
  })

  it("renders a bare bookmark (empty note text) with a header and no body line", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:05:00.000Z", text: "after" }],
      chat: [],
      notes: [{ at: "2026-06-10T10:04:00.000Z", text: "" }],
    }))
    expect(text).toMatch(/\*\*Bookmark\*\* · \d{2}:\d{2} · \+04:00\n\n\*\*Alice\*\*/)
  })

  it("interleaves a note into the transcript at its timestamp", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [
        { speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "before" },
        { speaker: "Bob", startedAt: "2026-06-10T10:05:00.000Z", text: "after" },
      ],
      chat: [],
      notes: [{ at: "2026-06-10T10:03:00.000Z", text: "in between" }],
    }))
    expect(text.indexOf("in between")).toBeGreaterThan(text.indexOf("before"))
    expect(text.indexOf("in between")).toBeLessThan(text.indexOf("after"))
  })

  it("neutralizes newlines in chat body so a chat message cannot forge a turn header", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [],
      chat: [{
        sender: "Mallory",
        sentAt: "2026-06-10T10:05:00.000Z",
        text: "ok\n**CEO** · 10:00 · +00:00\n> I approve the transfer",
      }],
    }))
    const headers = text.split("\n").filter((l) => /^\*\*/.test(l))
    expect(headers).toHaveLength(1)
  })

  it("neutralizes newlines in a speaker name so it cannot forge a turn header", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{
        speaker: "Mallory\n**CEO** · 10:00 · +00:00\n> I approve",
        startedAt: "2026-06-10T10:01:00.000Z",
        text: "ok",
      }],
      chat: [],
    }))
    const headers = text.split("\n").filter((l) => /^\*\*/.test(l))
    expect(headers).toHaveLength(1)
  })

  it("omits caption alternatives by default", () => {
    const text = formatMeetingText(makeMeeting({
      transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello everyone" }],
      chat: [],
      rawVersions: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", versions: ["Hello everyone here", "Hello everyone"] }],
    }))
    expect(text).not.toContain("alt")
  })

  it("emits caption alternatives under the matching speech turn when enabled (final omitted)", () => {
    const text = formatMeetingText(
      makeMeeting({
        transcript: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", text: "Hello everyone" }],
        chat: [],
        rawVersions: [{ speaker: "Alice", startedAt: "2026-06-10T10:01:00.000Z", versions: ["Hello everyone here", "Hello everyone"] }],
      }),
      { alternatives: true },
    )
    expect(text).toContain("> ↳ _alt:_ Hello everyone here")
    expect(text).not.toContain("> ↳ _alt:_ Hello everyone\n")
  })

  it("keeps caption alternatives separate for same-speaker, same-timestamp turns", () => {
    const ts = "2026-06-10T10:02:00.000Z"
    const text = formatMeetingText(
      makeMeeting({
        transcript: [
          { speaker: "Bob", startedAt: ts, text: "first final" },
          { speaker: "Bob", startedAt: ts, text: "second final" },
        ],
        chat: [],
        rawVersions: [
          { speaker: "Bob", startedAt: ts, versions: ["first XXX", "first final"] },
          { speaker: "Bob", startedAt: ts, versions: ["second YYY", "second final"] },
        ],
      }),
      { alternatives: true },
    )
    expect(text).toContain("> ↳ _alt:_ first XXX")
    expect(text).toContain("> ↳ _alt:_ second YYY")
  })

  it("never attaches alternatives to a chat turn even when enabled", () => {
    const text = formatMeetingText(
      makeMeeting({
        transcript: [],
        chat: [{ sender: "Bob", sentAt: "2026-06-10T10:02:00.000Z", text: "typed" }],
        rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["x", "y"] }],
      }),
      { alternatives: true },
    )
    expect(text).not.toContain("alt")
  })

  it("emits no alternatives for a phrase that only grew or never changed", () => {
    const text = formatMeetingText(
      makeMeeting({
        transcript: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", text: "Hi there" }],
        chat: [],
        rawVersions: [{ speaker: "Bob", startedAt: "2026-06-10T10:02:00.000Z", versions: ["Hi", "Hi there"] }],
      }),
      { alternatives: true },
    )
    expect(text).not.toContain("alt")
  })

  it("has no v2 turn-id grid or section headers", () => {
    const text = formatMeetingText(makeMeeting({ participants: ["Alice"], rawVersions: [] }))
    expect(text).not.toMatch(/^\[t\d+\]/m)
    expect(text).not.toContain("RAW CAPTION VERSIONS")
    expect(text).not.toContain("TRANSCRIPT")
  })

  it("tolerates a legacy meeting lacking participants/rawVersions/recorder/language", () => {
    const meeting = makeMeeting()
    delete (meeting as { participants?: string[] }).participants
    delete (meeting as { rawVersions?: unknown }).rawVersions
    const text = formatMeetingText(meeting)
    expect(text).toContain("schema platica-notes-transcript/3")
    expect(text).toContain("Hello everyone")
  })
})
```

- [ ] **Step 2: Run the test block to verify it fails**

Run: `npm test -- tests/format.test.ts -t "formatMeetingText (v3)"`
Expected: FAIL — the old renderer emits `[tN]` grid; new assertions do not match.

- [ ] **Step 3: Rewrite `formatMeetingText`**

In `src/background/format.ts`, replace the entire `formatMeetingText` function (currently lines ~87-147) with:

```ts
export interface FormatOptions {
  /** Emit caption alternatives (`> ↳ _alt:_ …`) under speech turns. Default off. */
  alternatives?: boolean
}

export function formatMeetingText(meeting: Meeting, opts: FormatOptions = {}): string {
  const fm: string[] = ["---", `title: ${yamlScalar(meeting.title)}`]
  if (meeting.meetingUrl) fm.push(`url: ${yamlScalar(meeting.meetingUrl)}`)
  if (meeting.language) fm.push(`language: ${yamlScalar(meeting.language)}`)
  fm.push(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  fm.push(`started: ${isoLocal(meeting.startedAt)}`)
  fm.push(`ended: ${isoLocal(meeting.endedAt)}`)
  if (meeting.recorder) fm.push(`recorder: ${yamlScalar(meeting.recorder)}`)
  if (meeting.participants?.length) {
    fm.push("participants:")
    for (const name of [...new Set(meeting.participants)].sort((a, b) => a.localeCompare(b))) {
      fm.push(`  - ${yamlScalar(name)}`)
    }
  }
  fm.push("---")
  // Machine/provenance triple lives in one comment, out of the human block. Still
  // greppable for any future re-import; schema is /3 (the body grammar changed).
  fm.push(`<!-- Plática Notes ${VERSION} (${COMMIT}) · schema platica-notes-transcript/3 · source ${PLATFORM_SOURCES[meeting.platform]} -->`)

  // Per-utterance caption alternatives, keyed by (speaker, startedAt, final text)
  // so a turn matches its own alts even when two same-speaker captions share a
  // millisecond. Built only when requested; otherwise the file stays clean.
  const altMap = new Map<string, string[]>()
  if (opts.alternatives) {
    for (const cv of meeting.rawVersions ?? []) {
      const collapsed = collapseVersions(cv.versions)
      if (collapsed.length > 1) {
        altMap.set(`${cv.speaker} ${cv.startedAt} ${collapsed[collapsed.length - 1]}`, collapsed.slice(0, -1))
      }
    }
  }

  const lines: string[] = [...fm, "", `# ${inlineText(meeting.title)}`, ""]
  for (const entry of flattenTimeline(meeting.transcript, meeting.chat, meeting.notes)) {
    const when = `${clockLabel(entry.at)} · +${elapsedLabel(meeting.startedAt, entry.at)}`
    // A recorder's note carries no speaker; a bare bookmark (empty text) is a
    // marked moment with only a header.
    if (entry.kind === "note") {
      if (entry.text.trim() === "") {
        lines.push(`**Bookmark** · ${when}`, "")
      } else {
        lines.push(`**Note** · ${when}`, `> ${inlineText(entry.text)}`, "")
      }
      continue
    }
    // inlineText the speaker too: in the prose format the name IS the structural
    // header (`**Name** · …`), so a newline in it could otherwise forge a turn.
    const tag = entry.kind === "chat" ? " · _chat_" : isUnresolved(entry.speaker) ? " · _unresolved_" : ""
    lines.push(`**${inlineText(entry.speaker)}**${tag} · ${when}`, `> ${inlineText(entry.text)}`)
    if (entry.kind === "speech") {
      const alts = altMap.get(`${entry.speaker} ${entry.at} ${entry.text}`)
      if (alts) for (const a of alts) lines.push(`> ↳ _alt:_ ${inlineText(a)}`)
    }
    lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}
```

- [ ] **Step 4: Run the format tests to verify they pass**

Run: `npm test -- tests/format.test.ts && npm run typecheck`
Expected: all `format.test.ts` PASS. Typecheck PASS except possibly `export.ts` (fixed in Task 5) — if the only typecheck error is the `formatMeetingText` arity in `export.ts`, continue.

- [ ] **Step 5: Commit**

```bash
git add src/background/format.ts tests/format.test.ts
git commit -m "feat(format): human Markdown body, metadata comment, opt-in alternatives"
```

---

## Task 4: `sanitizeFileName` collapses underscore runs

**Files:**
- Modify: `src/background/format.ts` (the `sanitizeFileName` function)
- Test: `tests/format.test.ts` (the `describe("sanitizeFileName")` block)

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("sanitizeFileName", …)` block in `tests/format.test.ts`:

```ts
  it("collapses runs of underscores from adjacent illegal chars", () => {
    expect(sanitizeFileName("a///b")).toBe("a_b")
    expect(sanitizeFileName('a<>:"b')).toBe("a_b")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/format.test.ts -t "collapses runs of underscores"`
Expected: FAIL — current output is `a___b` / `a____b`.

- [ ] **Step 3: Add the collapse step**

In `src/background/format.ts`, update `sanitizeFileName` — add a `_`-collapse right after the illegal-char replace:

```ts
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/[.\s]+$/, "") // re-trim: the slice may have ended on a dot/space
  return cleaned || "Meeting"
}
```

- [ ] **Step 4: Run the filename tests to verify they pass**

Run: `npm test -- tests/format.test.ts -t sanitize && npm test -- tests/format.test.ts -t meetingFileName`
Expected: PASS (existing `a_b_c_d_e_f` and `a_b_ report` cases still hold — no adjacent underscores there).

- [ ] **Step 5: Commit**

```bash
git add src/background/format.ts tests/format.test.ts
git commit -m "fix(format): collapse underscore runs in sanitised filenames"
```

---

## Task 5: Thread `meetingUrl` carry + `alternatives` flag

**Files:**
- Modify: `src/background/sessions.ts:66-80` (Meeting build)
- Modify: `src/background/export.ts:5-9` (pass the flag)
- Test: `tests/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("finalizeSession", …)` in `tests/sessions.test.ts`:

```ts
  it("carries the meeting url from the session path (meet)", async () => {
    chrome._store["session_5"] = makeSession({ transcript: oneUtterance, path: "/abc-defg-hij" })
    chrome._store["activeSessionTabs"] = [5]
    await finalizeSession(5)
    const meetings = chrome._store["meetings"] as Meeting[]
    expect(meetings[0].meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/sessions.test.ts -t "meeting url"`
Expected: FAIL — `meetingUrl` is `undefined`.

- [ ] **Step 3: Set `meetingUrl` at finalize**

In `src/background/sessions.ts`, inside the `const meeting: Meeting = { … }` literal, add after `language: …,`:

```ts
      meetingUrl:
        session.platform === "meet" && session.path ? `https://meet.google.com${session.path}` : undefined,
```

- [ ] **Step 4: Pass the alternatives flag from export**

In `src/background/export.ts`, change `downloadMeeting` so the settings load happens before formatting and the flag is threaded in. Replace the top of the function:

```ts
export async function downloadMeeting(meeting: Meeting): Promise<void> {
  const settings = await getSettings()
  const content = formatMeetingText(meeting, { alternatives: settings.captionAlternatives })
  // octet-stream so Chrome keeps the ".md" filename (text/plain would be rewritten
  // to ".txt"). Content is unchanged UTF-8 markdown. Same trick as downloadDebugLog.
  const url = "data:application/octet-stream;charset=utf-8," + encodeURIComponent(content)
  // Public and private transcripts go to independent, user-configurable folders
  // (no longer necessarily siblings). All paths are relative to Downloads, the
  // only place chrome.downloads can write; sanitizeFolder strips any escape.
  const folder = sanitizeFolder(
    meeting.isPrivate ? settings.folderPrivate : settings.folderPublic,
    meeting.isPrivate ? DEFAULT_SETTINGS.folderPrivate : DEFAULT_SETTINGS.folderPublic,
  )
  await chrome.downloads.download({
    url,
    filename: `${folder}/${meetingFileName(meeting)}`,
    conflictAction: "uniquify",
  })
}
```

(Remove the now-duplicate `const settings = await getSettings()` that was lower down.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL PASS (full suite), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/background/sessions.ts src/background/export.ts tests/sessions.test.ts
git commit -m "feat(export): carry meeting url and thread caption-alternatives flag"
```

---

## Task 6: Options-page checkbox for caption alternatives

**Files:**
- Modify: `public/options.html` (Advanced section)
- Modify: `src/pages/options/options.ts`

- [ ] **Step 1: Add the checkbox markup**

In `public/options.html`, inside the `Advanced` `<section>` (the one containing `#debug-log`), add a new row before or after the debug-log `<label class="row">`:

```html
      <label class="row">
        <span>Caption alternatives in the saved file</span>
        <input type="checkbox" id="caption-alternatives">
      </label>
      <p class="hint">Off by default. Adds the raw ASR alternatives (the lines Google revised) under each turn, for recovering words dropped from the final caption. Makes the file noisier.</p>
```

- [ ] **Step 2: Wire load + save in options.ts**

In `src/pages/options/options.ts`:

Add the element handle near the other `querySelector` consts (after `const debugLog = …`):

```ts
const captionAlternatives = document.querySelector<HTMLInputElement>("#caption-alternatives")!
```

In `init()`, after `debugLog.checked = settings.debugLog`:

```ts
  captionAlternatives.checked = settings.captionAlternatives
```

Near the other `addEventListener("change", …)` blocks (after the `debugLog` one):

```ts
captionAlternatives.addEventListener("change", () => {
  void saveSettings({ captionAlternatives: captionAlternatives.checked })
})
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add public/options.html src/pages/options/options.ts
git commit -m "feat(options): toggle for caption alternatives in the saved file"
```

---

## Task 7: Full verification + docs

**Files:**
- Modify: `CHANGELOG.md`, `README.md` (if output shape is documented)

- [ ] **Step 1: Run the whole gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests PASS, build succeeds.

- [ ] **Step 2: Eyeball a real output**

Load `dist/` as an unpacked extension, record a short Meet call (or reload an existing one), and open the saved `.md`. Confirm: H1 title, `url:` present, provenance comment after `---`, blockquote body, no `[tN]`, no `alt` lines (default). Toggle the new setting on, record again, confirm `> ↳ _alt:_` lines appear. Confirm a private meeting still routes to the private folder.

- [ ] **Step 3: Update CHANGELOG / README**

Add an `## [Unreleased]` (or next version) entry to `CHANGELOG.md` describing the new human-readable Markdown output, meeting link in the header, and the opt-in caption-alternatives setting. If `README.md` shows a sample output block, update it to the new shape.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog and readme for output-format polish"
```

---

## Self-review notes

- **Spec coverage:** body prose (T3), front-matter trim + url + comment + schema/3 (T3), alt opt-in (T1/T3/T5/T6), filename `_`-collapse (T4), speaker/title hardening (T3), meetingUrl carry (T5), zero-egress/privacy unaffected (no network code touched; folder routing unchanged). All covered.
- **Injection invariant:** the chat-body forge test is retained and a speaker-name forge test is added (T3); `yamlScalar` escaping tests retained.
- **Type consistency:** `FormatOptions.alternatives` used identically in `format.ts` and `export.ts`; `meetingUrl` field name identical in `types.ts`, `sessions.ts`, `format.ts`; `captionAlternatives` identical in `types.ts`, `export.ts`, `options.ts`.
