# Ask caption language at meeting start — design

> Status: approved 2026-06-30. A user-requested opt-in prompt that surfaces the
> caption-language choice at the start of every meeting, for people who switch
> spoken languages and forget to change the pill.
> Scope: one new setting + one in-meeting prompt component + a pure predicate +
> tests. Single implementation plan, TDD. Small, additive — no capture-path change.

## Goal

Some users meet in several spoken languages and forget to switch the in-meeting
language pill, so the meeting is captured in the wrong language. (When the
subscribed language ≠ the spoken language, Meet still emits captions — but
**phonetic gibberish**, not empty — so the transcript is garbage.) Let those users
opt into a loud prompt at meeting start. Users with one language are unaffected.

## What was decided (and rejected)

- **Auto-detect the spoken language: rejected — not feasible in-extension.** We
  read Meet's caption **data channel**, not audio, so there is no signal to detect
  the spoken language from; the caption text is always in the *subscribed*
  language's words, so "is this gibberish?" is not reliably distinguishable from
  real text; true language-ID would need audio + a bundled local model or a
  network API (which breaks the zero-network invariant).
- **Per-meeting language memory / smart "ask only when new": rejected** by the
  user in favour of a predictable toggle.
- **Capture-failure "no captions" toast: rejected** — wrong language produces
  captions (gibberish), so "no captions arrived" is not the right signal.
- **Blocking / gating capture until the language is chosen: rejected** by the user
  — never hold capture; never risk losing a meeting. The prompt is loud but
  **non-blocking**.

Accepted limitation: because the prompt does not gate capture, a user who *ignores*
it entirely still records the opening in the (possibly wrong) default language.
The prompt is a loud reminder, not a guarantee. This is the user's explicit choice
(predictability + zero data-loss risk over enforcement).

## Decisions (locked)

### 1. Setting

Add to `Settings`:

```ts
/** Show a prominent prompt at the start of each meeting to confirm/switch the
 *  caption language. Off by default. For users who meet in several languages and
 *  forget to switch the in-meeting pill. */
askLanguageEachMeeting: boolean
```

`DEFAULT_SETTINGS.askLanguageEachMeeting = false`. Off by default → existing users
and single-language users see no change. `withDefaults` backfills it, so no
explicit migration.

Options page: one checkbox, "Ask which language to use at the start of each
meeting", with a hint explaining it's for multi-language users.

### 2. When the prompt shows

On a **fresh** meeting start only, gated by a pure predicate:

```ts
shouldAskLanguage(ask: boolean, isResumed: boolean, uiHidden: boolean): boolean
  = ask && !isResumed && !uiHidden
```

- `ask` — the setting.
- `!isResumed` — a mid-meeting reload that resumes the session already has a
  chosen language; don't re-prompt. (`runMeeting` already computes `resumed`.)
- `!uiHidden` — if the user hid all extension UI (screen-share/demo), respect that
  and skip the prompt; it would be a jarring overlay otherwise. (`isUiHidden()`.)

Capture starts exactly as today (in the sticky default); the prompt is mounted
**after** capture is wired, never before — the capture path is untouched.

### 3. The prompt (loud, non-blocking)

A new `mountLanguagePrompt(opts)` in `src/content/core/ui.ts`, following the
existing pill/toast conventions (`position:fixed`, top-center, `registerUiEl` so
it honours hide-UI, `textContent` only):

- A prominent card, visually louder than the subtle pills (accent fill, larger),
  mounted top-center (above/overlapping the controls row). Does **not** block
  clicks to Meet (no full-screen modal backdrop that captures input).
- Copy: a title ("Recording language") and a line like "This meeting is being
  recorded in **{language}**. If it's in another language, switch now — otherwise
  the captions come out garbled."
- A language `<select>` built from `CAPTION_LANGUAGES` (same list as the pill),
  preset to the active language.
- A primary confirm button ("Record in {language}") that dismisses the prompt.
- A subtle "Don't ask again" link that turns the setting off
  (`saveSettings({ askLanguageEachMeeting: false })`) and dismisses — a quick
  opt-out for anyone it annoys.
- Persists until the user acts (confirm / pick a language / don't-ask-again); no
  auto-timeout, so it can't be missed. It never auto-dismisses on its own.

`mountLanguagePrompt` returns `{ unmount }`. The caller unmounts it in `endMeeting`
(alongside the other UI) and when the user acts.

### 4. Wiring (reuse the existing language path)

In `runMeeting` (`src/content/platforms/meet.ts`), after `mountMeetingControls` /
`mountTranscriptPanel`:

```ts
if (shouldAskLanguage(settings.askLanguageEachMeeting, !!resumed, isUiHidden())) {
  const prompt = mountLanguagePrompt({
    initialLanguage: session.captionLanguage ?? settings.captionLanguage,
    onPick: (language) => { applyLanguage(language); controls.setLanguage(language) },
    onDisableAsking: () => void saveSettings({ askLanguageEachMeeting: false }),
  })
  // unmount in endMeeting with the rest of the UI
}
```

- `applyLanguage(language)` is the **same** logic the pill's `onLanguageChange`
  already runs: set `session.captionLanguage` + `activeLanguage`, `writer.requestWrite()`,
  `pushRtcConfig(language, debugEnabled)` (resubscribe). It is **extracted** from
  the inline `onLanguageChange` in `mountMeetingControls` opts so both the pill and
  the prompt call one function — never persists to the default (ephemeral, this
  meeting only), matching today's pill semantics.
- `controls.setLanguage(language)` — a new accessor on `mountMeetingControls`'s
  return that updates the pill's `<select>` value + visible text **without** firing
  its change event, so the pill stays in sync when the prompt drives the change
  (no double-apply, no visual desync).
- The prompt is unmounted in `endMeeting` (add to the `controls.unmount()` /
  `panel.unmount()` block) and self-unmounts when the user acts.

### 5. Invariants

- **Zero network** — language list is the local `CAPTION_LANGUAGES`; no requests.
- **XSS-safe** — all prompt text via `textContent`.
- **Capture path untouched** — capture starts in the default exactly as today;
  prompt is purely additive UI. No data-loss risk (the 1.6.1/1.6.3 guarantees and
  the finalize path are not touched at all).
- **Privacy** — unaffected; no transcript content in the prompt.
- **Hide-UI honoured** — prompt is `registerUiEl`-tagged and skipped entirely when
  UI is hidden.

## Code map

- **Modify** `src/shared/types.ts` — `Settings.askLanguageEachMeeting` + default.
- **Modify** `src/content/platforms/meet-lifecycle.ts` — pure `shouldAskLanguage`.
- **Modify** `src/content/core/ui.ts` — `mountLanguagePrompt`; add `setLanguage` to
  `mountMeetingControls`'s return.
- **Modify** `src/content/platforms/meet.ts` — extract `applyLanguage`, wire the
  prompt in `runMeeting`, unmount in `endMeeting`.
- **Modify** `src/pages/options/options.ts` + `public/options.html` — the checkbox.
- **Tests** `tests/meet-lifecycle.test.ts` — `shouldAskLanguage` matrix.
- **Docs** `CHANGELOG.md`, `README.md`.

## Testing

- `shouldAskLanguage`: true only when `ask && !resumed && !hidden`; false in each
  of the other combinations (ask off; resumed; UI hidden).
- Setting default: `withDefaults({})` yields `askLanguageEachMeeting: false`
  (existing storage/types test pattern).
- `mountLanguagePrompt` and the `meet.ts` wiring are DOM glue (0%-coverage tier by
  project policy, like the pill); not unit-tested. Keep the decision logic in the
  pure predicate.
- Gate: `npm run typecheck`, `npm test`, `npm run build` green.

## Out of scope

- Auto language detection (see rejected, above).
- Per-meeting language memory / "ask only when new".
- Gating/holding capture until a choice is made.
- Persisting a per-meeting language as the new default (the prompt is ephemeral,
  like the pill).

## Release

Manual bump (the `npm run release` script is blocked by the local classifier):
`1.10.0 → 1.11.0` (a `feat` ⇒ minor) in `package.json` + `public/manifest.json`,
CHANGELOG + README, commit `chore(release): v1.11.0`, tag, `npm run package` to
build the Web Store zip artifact, ff-merge to `main`, push `main` + the tag
(`git push origin main v1.11.0`; needs VPN + 1Password SSH socket).
