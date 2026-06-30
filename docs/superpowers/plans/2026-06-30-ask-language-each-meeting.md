# Ask caption language at meeting start — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** An opt-in setting that shows a loud, non-blocking prompt at the start of each fresh meeting to confirm/switch the caption language, so multi-language users stop forgetting to switch the pill.

**Architecture:** Purely additive UI. Capture starts in the sticky default exactly as today; when the setting is on (and it's a fresh, non-hidden start) a prominent prompt mounts and routes a language choice through the SAME ephemeral path the in-meeting pill uses. The show/skip decision is a pure predicate. Spec: `docs/superpowers/specs/2026-06-30-ask-language-each-meeting-design.md`.

**Tech Stack:** TypeScript, esbuild, vitest. DOM glue (`ui.ts`, `meet.ts`) is the project's 0%-coverage tier — only the pure predicate is unit-tested.

---

## Task 1: Setting + default

**Files:** Modify `src/shared/types.ts`

- [ ] **Step 1:** In `Settings`, after `mergeRejoins: boolean`:

```ts
  /**
   * Show a prominent prompt at the start of each meeting to confirm/switch the
   * caption language. Off by default — for users who meet in several languages and
   * forget to switch the in-meeting pill. The prompt never blocks capture.
   */
  askLanguageEachMeeting: boolean
```

- [ ] **Step 2:** In `DEFAULT_SETTINGS`, after `mergeRejoins: false,`:

```ts
  askLanguageEachMeeting: false,
```

- [ ] **Step 3:** Run `npm run typecheck` — clean.
- [ ] **Step 4:** Commit:

```bash
git add src/shared/types.ts
git commit -m "feat(types): add Settings.askLanguageEachMeeting"
```

---

## Task 2: Pure predicate `shouldAskLanguage`

**Files:** Modify `src/content/platforms/meet-lifecycle.ts`; Test `tests/meet-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `tests/meet-lifecycle.test.ts` (it already imports from `../src/content/platforms/meet-lifecycle`; add `shouldAskLanguage` to that import):

```ts
describe("shouldAskLanguage", () => {
  it("asks only when enabled, on a fresh start, with UI visible", () => {
    expect(shouldAskLanguage(true, false, false)).toBe(true)
  })
  it("never asks when the setting is off", () => {
    expect(shouldAskLanguage(false, false, false)).toBe(false)
  })
  it("does not ask on a reload-resume (language already chosen)", () => {
    expect(shouldAskLanguage(true, true, false)).toBe(false)
  })
  it("does not ask while all UI is hidden", () => {
    expect(shouldAskLanguage(true, false, true)).toBe(false)
  })
})
```

- [ ] **Step 2:** Run `npx vitest run tests/meet-lifecycle.test.ts` — FAIL (`shouldAskLanguage` not exported).

- [ ] **Step 3: Implement.** Append to `src/content/platforms/meet-lifecycle.ts`:

```ts
// Whether to show the start-of-meeting language prompt: only when the user opted
// in, on a FRESH meeting (a reload-resume already has its language), and not while
// all extension UI is hidden (a deliberate clean view for screen-share/demo).
export function shouldAskLanguage(ask: boolean, isResumed: boolean, uiHidden: boolean): boolean {
  return ask && !isResumed && !uiHidden
}
```

- [ ] **Step 4:** Run `npx vitest run tests/meet-lifecycle.test.ts` — PASS.
- [ ] **Step 5:** Commit:

```bash
git add src/content/platforms/meet-lifecycle.ts tests/meet-lifecycle.test.ts
git commit -m "feat(lifecycle): shouldAskLanguage predicate"
```

---

## Task 3: UI — prompt component + pill `setLanguage` accessor

**Files:** Modify `src/content/core/ui.ts`

- [ ] **Step 1: Add `setLanguage` to `mountMeetingControls`'s return.** In the `return { unmount, setTranscriptActive }` object, add a `setLanguage` that updates the pill's `<select>` value + visible text WITHOUT firing its change event (so a prompt-driven change syncs the pill without double-applying):

```ts
  return {
    unmount: () => container.remove(),
    setTranscriptActive: (active: boolean) => {
      transcriptActive = active
      renderTranscript()
    },
    setLanguage: (language: string) => {
      if (![...select.options].some(o => o.value === language)) {
        const opt = document.createElement("option")
        opt.value = language
        opt.textContent = language
        select.appendChild(opt)
      }
      select.value = language
      syncLangText()
    },
  }
```

- [ ] **Step 2: Add `mountLanguagePrompt`.** Append to `src/content/core/ui.ts` a new exported function. Follows the pill/toast conventions: `position:fixed` top-center, `registerUiEl`, `textContent` only, no input-capturing backdrop. Accent fill so it's louder than the pills; persists until the user acts.

```ts
// A loud, NON-blocking start-of-meeting prompt to confirm/switch the caption
// language. Capture is already running in the default when this mounts; picking a
// language routes through the same ephemeral path as the pill (opts.onPick). It
// never gates capture and never auto-dismisses — it stays until the user acts.
export function mountLanguagePrompt(opts: {
  initialLanguage: string
  onPick: (language: string) => void
  onDisableAsking: () => void
}): { unmount: () => void } {
  const card = document.createElement("div")
  card.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
    "max-width:380px;background:#433b66;color:#fff;border-radius:12px;padding:14px 16px;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.4);font:14px system-ui;display:flex;flex-direction:column;gap:10px;"
  registerUiEl(card)

  const title = document.createElement("div")
  title.textContent = "Recording language"
  title.style.cssText = "font-weight:600;font-size:15px;"

  const labelFor = (value: string) =>
    CAPTION_LANGUAGES.find(l => l.value === value)?.label ?? value

  const body = document.createElement("div")
  body.style.cssText = "opacity:.92;line-height:1.35;"
  body.textContent =
    `This meeting is being recorded in ${labelFor(opts.initialLanguage)}. ` +
    "If it's in another language, switch now — otherwise the captions come out garbled."

  const select = document.createElement("select")
  select.style.cssText =
    "width:100%;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,.25);" +
    "background:rgba(0,0,0,.25);color:#fff;padding:0 8px;font:14px system-ui;cursor:pointer;"
  for (const lang of CAPTION_LANGUAGES) {
    const opt = document.createElement("option")
    opt.value = lang.value
    opt.textContent = lang.label
    select.appendChild(opt)
  }
  if (![...select.options].some(o => o.value === opts.initialLanguage)) {
    const opt = document.createElement("option")
    opt.value = opts.initialLanguage
    opt.textContent = opts.initialLanguage
    select.appendChild(opt)
  }
  select.value = opts.initialLanguage

  const confirm = document.createElement("button")
  confirm.type = "button"
  confirm.style.cssText =
    "height:36px;border:none;border-radius:8px;background:#6750a4;color:#fff;cursor:pointer;" +
    'font:600 14px system-ui;'
  const renderConfirm = () => { confirm.textContent = `Record in ${labelFor(select.value)}` }
  renderConfirm()
  select.addEventListener("change", renderConfirm)

  const dismiss = () => card.remove()
  confirm.addEventListener("click", () => {
    // Apply only on an actual change — confirming the default is a pure dismiss
    // (capture is already running in it; no needless resubscribe).
    if (select.value !== opts.initialLanguage) opts.onPick(select.value)
    dismiss()
  })

  const noAsk = document.createElement("button")
  noAsk.type = "button"
  noAsk.textContent = "Don't ask again"
  noAsk.style.cssText =
    "background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;" +
    "font:13px system-ui;text-decoration:underline;align-self:flex-start;padding:0;"
  noAsk.addEventListener("click", () => { opts.onDisableAsking(); dismiss() })

  card.append(title, body, select, confirm, noAsk)
  document.documentElement.appendChild(card)
  return { unmount: dismiss }
}
```

- [ ] **Step 3:** Run `npm run typecheck && npm run build` — clean; bundles rebuilt.
- [ ] **Step 4:** Commit:

```bash
git add src/content/core/ui.ts
git commit -m "feat(ui): start-of-meeting language prompt + pill setLanguage"
```

---

## Task 4: Wire the prompt into the meeting lifecycle

**Files:** Modify `src/content/platforms/meet.ts`

- [ ] **Step 1: Import.** Add `mountLanguagePrompt` to the `ui` import, and `shouldAskLanguage` to the `meet-lifecycle` import:

```ts
import { isUiHidden, mountLanguagePrompt, mountMeetingControls, pulseActivity, setUiHidden, showToast } from "../core/ui"
import { nextLeaveState, seedAttendees, shouldAskLanguage, shouldDrainTail, shouldFinalizeStaleSession, shouldFinishRearmWait } from "./meet-lifecycle"
```

- [ ] **Step 2: Extract `applyLanguage`.** In `runMeeting`, before `mountMeetingControls`, add a single shared handler and use it for the pill's `onLanguageChange`:

```ts
  // The ephemeral, this-meeting-only language switch shared by the pill and the
  // start-of-meeting prompt: resubscribe + snapshot into the session, never write
  // the persisted default (so the next meeting still starts from the default).
  const applyLanguage = (language: string): void => {
    session.captionLanguage = language
    activeLanguage = language
    writer.requestWrite()
    pushRtcConfig(language, debugEnabled)
  }
```

Then change the existing `onLanguageChange` passed to `mountMeetingControls` to delegate:

```ts
    onLanguageChange: (language) => applyLanguage(language),
```

- [ ] **Step 3: Mount the prompt after the controls/panel.** After `panel.update(...)` (the initial panel render) — or anywhere after `controls`/`panel` exist — add:

```ts
  // Opt-in start-of-meeting language prompt (loud, non-blocking). Fresh starts
  // only, never on a reload-resume, and skipped while all UI is hidden.
  let languagePrompt: { unmount: () => void } | null = null
  if (shouldAskLanguage(settings.askLanguageEachMeeting, !!resumed, isUiHidden())) {
    languagePrompt = mountLanguagePrompt({
      initialLanguage: session.captionLanguage ?? settings.captionLanguage,
      onPick: (language) => { applyLanguage(language); controls.setLanguage(language) },
      onDisableAsking: () => void saveSettings({ askLanguageEachMeeting: false }),
    })
  }
```

(`saveSettings` is already imported in `meet.ts`.)

- [ ] **Step 4: Unmount on end.** In `endMeeting`, alongside `controls.unmount()` / `panel.unmount()`:

```ts
    languagePrompt?.unmount()
```

- [ ] **Step 5:** Run `npm run typecheck && npm run build` — clean.
- [ ] **Step 6:** Commit:

```bash
git add src/content/platforms/meet.ts
git commit -m "feat(meet): show the language prompt at meeting start when enabled"
```

---

## Task 5: Options checkbox

**Files:** Modify `public/options.html`, `src/pages/options/options.ts`

- [ ] **Step 1: HTML.** In the `Advanced` `<section>`, after the merge-rejoins hint and before the debug-log label:

```html
      <label class="row">
        <span>Ask which language to use at the start of each meeting</span>
        <input type="checkbox" id="ask-language">
      </label>
      <p class="hint">Off by default. For meetings in different languages: shows a prompt at the start so you can confirm or switch the caption language before it records in the wrong one.</p>
```

- [ ] **Step 2: TS handle.** After `const mergeRejoins = ...`:

```ts
const askLanguage = document.querySelector<HTMLInputElement>("#ask-language")!
```

- [ ] **Step 3: init.** After `mergeRejoins.checked = settings.mergeRejoins`:

```ts
  askLanguage.checked = settings.askLanguageEachMeeting
```

- [ ] **Step 4: listener.** After the `mergeRejoins` change listener:

```ts
askLanguage.addEventListener("change", () => {
  void saveSettings({ askLanguageEachMeeting: askLanguage.checked })
})
```

- [ ] **Step 5:** Run `npm run typecheck && npm run build` — clean.
- [ ] **Step 6:** Commit:

```bash
git add public/options.html src/pages/options/options.ts
git commit -m "feat(options): toggle to ask language at meeting start"
```

---

## Task 6: Docs

**Files:** Modify `CHANGELOG.md`, `README.md`

- [ ] **Step 1: CHANGELOG.** Add a new top section above `## 1.10.0 - 2026-06-30`:

```markdown
## 1.11.0 - 2026-06-30

- **Optional language prompt at meeting start.** For people who meet in several
  languages and forget to switch: turn on "Ask which language to use at the start
  of each meeting" in Settings and a prompt appears as each meeting begins, letting
  you confirm or switch the caption language before it records in the wrong one.
  Off by default; it never interrupts recording, and has a "Don't ask again" link.
```

- [ ] **Step 2: README.** In the Settings list, after the "Merge rejoined visits" bullet:

```markdown
- **Ask language at meeting start.** Shows a prompt when each meeting begins to
  confirm or switch the caption language. Off by default — for people who meet in
  several languages. It never blocks recording.
```

- [ ] **Step 3: Full gate.** Run `npm run typecheck && npm test && npm run build` — all green; note the test count.
- [ ] **Step 4:** Commit:

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog and readme for ask-language-at-meeting-start"
```

---

## Task 7: Release + artifact + push

> `npm run release` is blocked by the local classifier; bump by hand.

- [ ] **Step 1:** Bump `1.10.0 → 1.11.0` in `package.json` and `public/manifest.json`.
- [ ] **Step 2:** Commit + tag:

```bash
git add package.json public/manifest.json
git commit -m "chore(release): v1.11.0"
git tag v1.11.0
```

- [ ] **Step 3: Build the Web Store artifact.** Run `npm run package` — runs typecheck + tests + build, then writes `platica-notes-1.11.0.zip` (git-ignored; the Web Store upload artifact). Confirm the version stamp in the zip.
- [ ] **Step 4: Integrate.** ff-merge to main:

```bash
git checkout main
git merge --ff-only feat/ask-language-each-meeting
```

- [ ] **Step 5: Push** (needs VPN + 1Password SSH socket):

```bash
SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" git push origin main v1.11.0
```

- [ ] **Step 6:** Delete the merged branch: `git branch -d feat/ask-language-each-meeting`.

---

## Notes for the implementer

- Run the FULL suite (`npm test`) at Task 6 — the only new test is `shouldAskLanguage`, but confirm nothing regressed.
- Do not touch the capture/finalize path. This feature is additive UI + one setting + one predicate.
- Invariants: zero network (local `CAPTION_LANGUAGES`), XSS-safe (`textContent`), hide-UI honoured (`registerUiEl` + the `!uiHidden` guard), capture path unchanged.
