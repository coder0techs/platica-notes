import { CAPTION_LANGUAGES, orderedLanguages } from "../../shared/languages"

const PULSE_ID = "platica-pulse"

// --- global show/hide of every on-screen extension element ---------------------
// Each injected root element is tagged with UI_EL_CLASS and shown/hidden via
// `visibility` (not `display`): visibility is orthogonal to the transcript
// panel's own display-based open/closed toggle, so the two never fight. All our
// elements are position:fixed, so a hidden one reserves no layout and is fully
// non-interactive. Capture is unaffected — this is purely presentational.
const UI_EL_CLASS = "platica-ui-el"
let uiHidden = false

/** Tag a root extension element and apply the current visibility immediately, so
 * an element created while the UI is hidden is born hidden. */
export function registerUiEl(el: HTMLElement): void {
  el.classList.add(UI_EL_CLASS)
  el.style.visibility = uiHidden ? "hidden" : ""
}

/** Show or hide all extension UI. Idempotent; safe to call before any element
 * exists (later elements pick up the state via registerUiEl). */
export function setUiHidden(hidden: boolean): void {
  uiHidden = hidden
  for (const el of document.querySelectorAll<HTMLElement>("." + UI_EL_CLASS)) {
    el.style.visibility = hidden ? "hidden" : ""
  }
}

export function isUiHidden(): boolean {
  return uiHidden
}
// -------------------------------------------------------------------------------

/** Brief top-bar flash confirming a storage write happened. */
export function pulseActivity(): void {
  let bar = document.getElementById(PULSE_ID)
  if (!bar) {
    bar = document.createElement("div")
    bar.id = PULSE_ID
    bar.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:3px;z-index:2147483647;" +
      "pointer-events:none;transition:background-color .3s ease-in;background-color:transparent;"
    registerUiEl(bar)
    document.documentElement.appendChild(bar)
  }
  bar.style.backgroundColor = "#6750a4"
  setTimeout(() => { bar.style.backgroundColor = "transparent" }, 1500)
}

// Soft purple fill so a notice reads as the extension's own UI (matching the
// purple pulse bar / transcript pill) rather than a plain black tooltip —
// noticeable without shouting.
const TOAST_BG = "#433b66"
const TOAST_ID = "platica-toast"

export function showToast(message: string, durationMs = 8000): void {
  // Single toast at a time: a new one replaces any still on screen, so two toasts
  // (e.g. the start notice and a language-change confirmation) can never stack on
  // the same spot.
  document.getElementById(TOAST_ID)?.remove()
  const toast = document.createElement("div")
  toast.id = TOAST_ID
  toast.textContent = message
  // Sits just below the persistent top-center controls (top:12px).
  toast.style.cssText =
    "position:fixed;top:64px;left:50%;transform:translateX(-50%);color:#fff;" +
    `background:${TOAST_BG};` +
    "padding:10px 16px;border-radius:8px;font:14px system-ui;z-index:2147483647;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);"
  registerUiEl(toast)
  document.documentElement.appendChild(toast)
  setTimeout(() => toast.remove(), durationMs)
}

// Amber, so a notice that needs action reads distinctly from the on-brand purple
// toast (which just confirms things are fine).
const NOTICE_BG = "#7a4b00"
const NOTICE_ID = "platica-notice"

/**
 * A persistent, dismissible banner for a state the user must act on (e.g. the
 * extension was updated mid-meeting and capture can't continue until they reload).
 * Unlike showToast it never auto-dismisses. Single instance: a second call
 * replaces the first. Respects hide-UI via registerUiEl.
 */
export function showPersistentNotice(message: string): { dismiss: () => void } {
  document.getElementById(NOTICE_ID)?.remove()
  const notice = document.createElement("div")
  notice.id = NOTICE_ID
  // Sits below the top-center controls row, same lane as the toast.
  notice.style.cssText =
    "position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
    "box-sizing:border-box;max-width:min(460px,calc(100vw - 24px));display:flex;align-items:center;gap:10px;" +
    `background:${NOTICE_BG};color:#fff;padding:11px 14px;border-radius:8px;` +
    "font:14px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.35);"

  const text = document.createElement("span")
  text.textContent = message
  text.style.cssText = "flex:1;line-height:1.35;"

  const close = document.createElement("button")
  close.type = "button"
  close.textContent = "✕"
  close.setAttribute("aria-label", "Dismiss")
  close.style.cssText =
    "flex:none;background:none;border:none;color:rgba(255,255,255,.8);cursor:pointer;" +
    "font:16px system-ui;line-height:1;padding:0 2px;"
  const dismiss = () => notice.remove()
  close.addEventListener("click", dismiss)

  notice.append(text, close)
  registerUiEl(notice)
  document.documentElement.appendChild(notice)
  return { dismiss }
}

// Shared Google-Meet-native dark pill style so the language select and privacy
// toggle read as one native control group.
const PILL_BASE =
  "box-sizing:border-box;height:34px;display:flex;align-items:center;gap:6px;" +
  "background:rgba(32,33,36,.92);color:#e8eaed;border:1px solid rgba(255,255,255,.14);" +
  "border-radius:18px;padding:0 14px;" +
  'font:500 13px "Google Sans",Roboto,system-ui,sans-serif;cursor:pointer;'
const PILL_BG = "rgba(32,33,36,.92)"
const PILL_BG_HOVER = "rgba(60,64,67,.95)"

/**
 * Per-meeting on-screen controls, mounted top-center as one cohesive native-looking
 * group: a caption-language select, a transcript-panel toggle, and a privacy
 * toggle. Returns `unmount` plus `setTranscriptActive` so the caller can mirror the
 * panel's open/closed state on the toggle pill.
 */
export function mountMeetingControls(opts: {
  initialLanguage: string
  initialPrivate: boolean
  initialRecording: boolean
  onLanguageChange: (language: string) => void
  /** Up to three tags pinned to the top of the language list. */
  favouriteLanguages?: string[]
  onPrivateChange: (isPrivate: boolean) => void
  onRecordingChange: (recording: boolean) => void
  onToggleTranscript: () => void
  onPurge: () => void
}): { unmount: () => void; setTranscriptActive: (active: boolean) => void; setLanguage: (language: string) => void } {
  const container = document.createElement("div")
  container.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:2147483647;"
  registerUiEl(container)

  // --- language pill: a visual layer (glyph + label + caret) with a transparent
  // native <select> stretched over the WHOLE pill, so a click anywhere on the pill
  // opens the OS dropdown (not just the narrow text zone). ---
  const langPill = document.createElement("div")
  langPill.style.cssText = PILL_BASE + "position:relative;"
  langPill.title = "Plática Notes: caption language for this meeting (resets to your default next time)"
  langPill.addEventListener("mouseenter", () => { langPill.style.background = PILL_BG_HOVER })
  langPill.addEventListener("mouseleave", () => { langPill.style.background = PILL_BG })

  const langVisual = document.createElement("span")
  langVisual.style.cssText = "display:flex;align-items:center;gap:6px;pointer-events:none;"
  const langGlyph = document.createElement("span")
  langGlyph.textContent = "🌐"
  const langText = document.createElement("span")
  const caret = document.createElement("span")
  caret.textContent = "▾"
  caret.style.cssText = "opacity:.7;margin-left:2px;"
  langVisual.append(langGlyph, langText, caret)

  const select = document.createElement("select")
  // Transparent, covers the whole pill so the entire pill is the click target.
  select.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:none;margin:0;"
  // Flat list, no header row. The native dropdown renders an optgroup/disabled
  // header in low-contrast grey (hard to read on the dark menu) and scrolls it out
  // of view once a lower item is selected, so a header here is both unreadable and
  // useless. The per-meeting scope is conveyed by the pill tooltip, the post-change
  // toast ("· only this meeting"), and the start-of-meeting language prompt instead.
  // Pinned languages first, then a disabled divider, then the rest. The order is
  // the whole signal: a divider is a line, not a header row, so it dodges the
  // unreadable-grey problem described above while still showing where the
  // shortlist ends.
  for (const lang of orderedLanguages(CAPTION_LANGUAGES, opts.favouriteLanguages)) {
    const opt = document.createElement("option")
    opt.value = lang.value
    opt.textContent = lang.label
    if (lang.separator) opt.disabled = true
    select.appendChild(opt)
  }
  select.value = opts.initialLanguage
  if (select.value !== opts.initialLanguage) {
    // Stored value is not among the built-in options (future tag, manual value).
    const opt = document.createElement("option")
    opt.value = opts.initialLanguage
    opt.textContent = opts.initialLanguage
    select.appendChild(opt)
    select.value = opts.initialLanguage
  }
  const syncLangText = () => {
    langText.textContent = select.selectedOptions[0]?.textContent ?? select.value
  }
  select.addEventListener("change", () => {
    syncLangText()
    opts.onLanguageChange(select.value)
    // Confirm the change and reinforce that it is scoped to this meeting only.
    // Shorter than the default — it's a quick confirmation, not an onboarding cue.
    showToast(`🌐 ${langText.textContent} · only this meeting`, 4000)
  })
  syncLangText()

  langPill.append(langVisual, select)

  // --- transcript pill: toggles the live transcript panel. Highlighted (purple)
  // while the panel is open; the caller keeps this in sync via setTranscriptActive. ---
  const TRANSCRIPT_BG_ACTIVE = "rgba(103,80,164,.95)"
  let transcriptActive = false
  const transcriptPill = document.createElement("button")
  transcriptPill.type = "button"
  transcriptPill.style.cssText = PILL_BASE
  transcriptPill.textContent = "📄 Transcript"
  transcriptPill.title = "Plática Notes: show/hide the live transcript panel"
  const renderTranscript = () => {
    transcriptPill.style.background = transcriptActive ? TRANSCRIPT_BG_ACTIVE : PILL_BG
  }
  transcriptPill.addEventListener("mouseenter", () => {
    if (!transcriptActive) transcriptPill.style.background = PILL_BG_HOVER
  })
  transcriptPill.addEventListener("mouseleave", renderTranscript)
  transcriptPill.addEventListener("click", () => { opts.onToggleTranscript() })
  renderTranscript()

  // --- privacy pill: the label is always "Private" and the text color never
  // changes; state is shown by FILLING the whole pill red when the meeting is
  // private (Meet-native red, like the leave button) and leaving it the default
  // dark otherwise — same active-by-background pattern as the transcript pill. ---
  const PRIVACY_BG_ACTIVE = "rgba(217,48,37,.95)" // red fill when private — noticeable
  let isPrivate = opts.initialPrivate
  const privacyPill = document.createElement("button")
  privacyPill.type = "button"
  privacyPill.style.cssText = PILL_BASE
  privacyPill.title = "Plática Notes: mark this meeting private (local-only folder)"
  const renderPrivacy = () => {
    privacyPill.textContent = "🔒 Private"
    privacyPill.style.background = isPrivate ? PRIVACY_BG_ACTIVE : PILL_BG
  }
  privacyPill.addEventListener("mouseenter", () => {
    if (!isPrivate) privacyPill.style.background = PILL_BG_HOVER
  })
  privacyPill.addEventListener("mouseleave", renderPrivacy)
  privacyPill.addEventListener("click", () => {
    isPrivate = !isPrivate
    renderPrivacy()
    opts.onPrivateChange(isPrivate)
  })
  renderPrivacy()

  // --- recording pill: On FILLS the pill red — the universal "recording live"
  // indicator, same active-by-background idiom as the privacy pill; Off fills it
  // grey (muted/stopped). A stopped recording is impossible to miss. Toggling flips
  // the flag via onRecordingChange. ---
  const RECORDING_BG_ON = "rgba(217,48,37,.95)" // red fill while recording (Meet-native red)
  const RECORDING_BG_OFF = "rgba(95,99,104,.95)" // grey fill while stopped
  let recording = opts.initialRecording
  const recordingPill = document.createElement("button")
  recordingPill.type = "button"
  recordingPill.style.cssText = PILL_BASE
  recordingPill.title = "Plática Notes: pause/resume capturing this meeting"
  const renderRecording = () => {
    recordingPill.textContent = recording ? "● Rec" : "⏸ Rec off"
    recordingPill.style.background = recording ? RECORDING_BG_ON : RECORDING_BG_OFF
  }
  recordingPill.addEventListener("mouseenter", () => {
    if (!recording) recordingPill.style.background = PILL_BG_HOVER
  })
  recordingPill.addEventListener("mouseleave", renderRecording)
  recordingPill.addEventListener("click", () => {
    recording = !recording
    renderRecording()
    opts.onRecordingChange(recording)
  })
  renderRecording()

  // --- wipe pill: destructive clean-slate for the current meeting. Two-click
  // confirm inline (no native dialog): first click arms for 4s, second click within
  // the window fires onPurge. Reverts on timeout. ---
  const WIPE_BG_ARMED = "rgba(249,171,0,.95)" // yellow while armed (caution before confirm)
  let wipeArmed = false
  let wipeTimer: ReturnType<typeof setTimeout> | undefined
  const wipePill = document.createElement("button")
  wipePill.type = "button"
  wipePill.style.cssText = PILL_BASE
  wipePill.title = "Plática Notes: wipe everything captured in this meeting so far"
  const disarmWipe = () => {
    wipeArmed = false
    if (wipeTimer) clearTimeout(wipeTimer)
    wipeTimer = undefined
    wipePill.textContent = "🗑 Wipe"
    wipePill.style.background = PILL_BG
  }
  wipePill.addEventListener("mouseenter", () => {
    if (!wipeArmed) wipePill.style.background = PILL_BG_HOVER
  })
  wipePill.addEventListener("mouseleave", () => {
    if (!wipeArmed) wipePill.style.background = PILL_BG
  })
  wipePill.addEventListener("click", () => {
    if (!wipeArmed) {
      wipeArmed = true
      wipePill.textContent = "🗑 Wipe? confirm"
      wipePill.style.background = WIPE_BG_ARMED
      wipeTimer = setTimeout(disarmWipe, 4000)
      return
    }
    disarmWipe()
    opts.onPurge()
  })
  wipePill.textContent = "🗑 Wipe"

  container.append(langPill, transcriptPill, recordingPill, wipePill, privacyPill)
  document.documentElement.appendChild(container)
  return {
    unmount: () => container.remove(),
    setTranscriptActive: (active: boolean) => {
      transcriptActive = active
      renderTranscript()
    },
    // Set the pill's language without firing its change event — used when the
    // start-of-meeting prompt drives the change, so the pill stays in sync without
    // re-applying (no double resubscribe).
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
}

// A loud, NON-blocking start-of-meeting prompt to confirm/switch the caption
// language. Capture is already running in the default when this mounts; picking a
// language routes through the same ephemeral path as the pill (opts.onPick). It
// never gates capture and never auto-dismisses — it stays until the user acts.
export function mountLanguagePrompt(opts: {
  initialLanguage: string
  onPick: (language: string) => void
  onDisableAsking: () => void
  /** Up to three tags pinned to the top of the language list. */
  favouriteLanguages?: string[]
}): { unmount: () => void } {
  const labelFor = (value: string) => CAPTION_LANGUAGES.find(l => l.value === value)?.label ?? value

  const card = document.createElement("div")
  // Sits just below the controls row (top:12px, height 34px) so both stay visible.
  card.style.cssText =
    "position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
    "box-sizing:border-box;width:min(380px,calc(100vw - 24px));background:#433b66;color:#fff;" +
    "border-radius:12px;padding:14px 16px;box-shadow:0 6px 24px rgba(0,0,0,.4);" +
    "font:14px system-ui;display:flex;flex-direction:column;gap:10px;"
  registerUiEl(card)

  const title = document.createElement("div")
  title.textContent = "Recording language"
  title.style.cssText = "font-weight:600;font-size:15px;"

  const body = document.createElement("div")
  body.style.cssText = "opacity:.92;line-height:1.35;"
  body.textContent =
    `This meeting is being recorded in ${labelFor(opts.initialLanguage)}. ` +
    "If it's in another language, switch now — otherwise the captions come out garbled."

  const select = document.createElement("select")
  select.style.cssText =
    "width:100%;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,.25);" +
    "background:rgba(0,0,0,.25);color:#fff;padding:0 8px;font:14px system-ui;cursor:pointer;"
  // Pinned languages first, then a disabled divider, then the rest. The order is
  // the whole signal: a divider is a line, not a header row, so it dodges the
  // unreadable-grey problem described above while still showing where the
  // shortlist ends.
  for (const lang of orderedLanguages(CAPTION_LANGUAGES, opts.favouriteLanguages)) {
    const opt = document.createElement("option")
    opt.value = lang.value
    opt.textContent = lang.label
    if (lang.separator) opt.disabled = true
    select.appendChild(opt)
  }
  if (![...select.options].some(o => o.value === opts.initialLanguage)) {
    const opt = document.createElement("option")
    opt.value = opts.initialLanguage
    opt.textContent = opts.initialLanguage
    select.appendChild(opt)
  }
  select.value = opts.initialLanguage

  const dismiss = () => card.remove()
  // Picking a language in the dropdown applies it and closes the prompt in one
  // step — `change` only fires on a real switch, so no separate confirm click is
  // needed. Capture resubscribes via onPick.
  select.addEventListener("change", () => { opts.onPick(select.value); dismiss() })

  // The default is already what capture is using; this is the one-click path when
  // the language is already right — confirm and close, no resubscribe.
  const keep = document.createElement("button")
  keep.type = "button"
  keep.style.cssText =
    "height:36px;border:none;border-radius:8px;background:#6750a4;color:#fff;cursor:pointer;" +
    'font:600 14px system-ui;'
  keep.textContent = `Keep ${labelFor(opts.initialLanguage)}`
  keep.addEventListener("click", dismiss)

  const noAsk = document.createElement("button")
  noAsk.type = "button"
  noAsk.textContent = "Don't ask again"
  noAsk.style.cssText =
    "background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;" +
    "font:13px system-ui;text-decoration:underline;align-self:flex-start;padding:0;"
  noAsk.addEventListener("click", () => { opts.onDisableAsking(); dismiss() })

  card.append(title, body, select, keep, noAsk)
  document.documentElement.appendChild(card)
  return { unmount: dismiss }
}
