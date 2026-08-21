import { CAPTION_LANGUAGES, isDivider, MAX_FAVOURITE_LANGUAGES, orderedLanguages } from "../../shared/languages"
import { ensureStyles } from "./styles"

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
 * an element created while the UI is hidden is born hidden. Also guarantees the
 * scoped stylesheet is present before anything is drawn. */
export function registerUiEl(el: HTMLElement): void {
  ensureStyles()
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

/** The chords are the same physical keys everywhere; only the label differs. */
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)
const HIDE_CHORD = isMac ? "⌥⇧H" : "Alt+Shift+H"
const BOOKMARK_CHORD = isMac ? "⌥⇧B" : "Alt+Shift+B"

/** Brief top-bar flash confirming a storage write happened. */
export function pulseActivity(): void {
  let bar = document.getElementById(PULSE_ID)
  if (!bar) {
    bar = document.createElement("div")
    bar.id = PULSE_ID
    bar.className = "pn-pulse"
    registerUiEl(bar)
    document.documentElement.appendChild(bar)
  }
  bar.style.backgroundColor = "#c58af9"
  setTimeout(() => { bar.style.backgroundColor = "transparent" }, 1500)
}

const TOAST_ID = "platica-toast"
const NOTICE_ID = "platica-notice"

function closeButton(onClick: () => void, label: string): HTMLButtonElement {
  const close = document.createElement("button")
  close.type = "button"
  close.className = "pn-close"
  close.textContent = "✕"
  close.setAttribute("aria-label", label)
  close.addEventListener("click", onClick)
  return close
}

// Three seconds. A toast here only ever confirms something: capture started, the
// language switched, the wipe went through. It sits over someone's face on a video
// call, the state it reports is also on the permanent recording pill, and it has a
// dismiss button for the impatient. Anything that needs acting on is a
// showPersistentNotice instead, which never auto-dismisses. One duration, so no
// call site has to argue about its own.
const TOAST_MS = 3000

export function showToast(message: string, durationMs = TOAST_MS): void {
  // Single toast at a time: a new one replaces any still on screen, so two toasts
  // (e.g. the start notice and a language-change confirmation) can never stack on
  // the same spot.
  document.getElementById(TOAST_ID)?.remove()
  const toast = document.createElement("div")
  toast.id = TOAST_ID
  toast.className = "pn-toast"

  const text = document.createElement("span")
  text.className = "pn-msg-text"
  text.textContent = message

  // Dismissable, because it sits over a live meeting: eight seconds is a long
  // time for a confirmation to cover somebody's face.
  const timer = setTimeout(() => toast.remove(), durationMs)
  toast.append(text, closeButton(() => {
    clearTimeout(timer)
    toast.remove()
  }, "Dismiss"))

  registerUiEl(toast)
  document.documentElement.appendChild(toast)
}

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
  notice.className = "pn-notice"
  notice.setAttribute("role", "alert")

  const text = document.createElement("span")
  text.className = "pn-msg-text"
  text.textContent = message

  const dismiss = (): void => notice.remove()
  notice.append(text, closeButton(dismiss, "Dismiss"))
  registerUiEl(notice)
  document.documentElement.appendChild(notice)
  return { dismiss }
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** HH:MM:SS since `iso`, fixed width so the pill never resizes as it counts. */
function elapsed(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`
}

/**
 * Per-meeting on-screen controls, mounted top-center as one cohesive group: a
 * recording pill carrying the elapsed clock, one button per pinned language, and
 * an overflow menu holding the caption-language list, the transcript-panel
 * toggle, the privacy toggle and the wipe action. Returns `unmount` plus
 * `setTranscriptActive` / `setLanguage` so the caller can mirror state onto it.
 */
export function mountMeetingControls(opts: {
  initialLanguage: string
  initialPrivate: boolean
  initialRecording: boolean
  /** Meeting start, for the elapsed clock on the recording pill. */
  startedAt?: string
  onLanguageChange: (language: string) => void
  /** Up to three tags pinned to the top of the language list. */
  favouriteLanguages?: string[]
  onPrivateChange: (isPrivate: boolean) => void
  onRecordingChange: (recording: boolean) => void
  onToggleTranscript: () => void
  onPurge: () => void
}): { unmount: () => void; setTranscriptActive: (active: boolean) => void; setLanguage: (language: string) => void } {
  const container = document.createElement("div")
  container.className = "pn-bar"
  registerUiEl(container)

  // --- language row: a visual layer (glyph + label + caret) with a transparent
  // native <select> stretched over the WHOLE row, so a click anywhere on it opens
  // the OS dropdown (not just the narrow text zone). ---
  const langRow = document.createElement("div")
  langRow.className = "pn-row"
  langRow.dataset.pn = "language"
  langRow.title = "Caption language for this meeting (resets to your default next time)"

  const langGlyph = document.createElement("span")
  langGlyph.textContent = "🌐"
  const langText = document.createElement("span")
  const caret = document.createElement("span")
  caret.className = "pn-row-end"
  caret.textContent = "▾"

  const select = document.createElement("select")
  select.className = "pn-row-select"
  select.setAttribute("aria-label", "Caption language for this meeting")
  // Flat list, no header row. The native dropdown renders an optgroup/disabled
  // header in low-contrast grey (hard to read on the dark menu) and scrolls it out
  // of view once a lower item is selected, so a header here is both unreadable and
  // useless. The per-meeting scope is conveyed by the row tooltip, the post-change
  // toast ("· only this meeting"), and the start-of-meeting language prompt instead.
  // Pinned languages first, then a disabled divider, then the rest. The order is
  // the whole signal: a divider is a line, not a header row, so it dodges the
  // unreadable-grey problem described above while still showing where the
  // shortlist ends.
  for (const lang of orderedLanguages(CAPTION_LANGUAGES, opts.favouriteLanguages)) {
    const opt = document.createElement("option")
    opt.value = lang.value
    opt.textContent = lang.label
    if (isDivider(lang)) opt.disabled = true
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
  const syncLangText = (): void => {
    langText.textContent = select.selectedOptions[0]?.textContent ?? select.value
  }
  select.addEventListener("change", () => {
    syncLangText()
    syncLangButtons()
    opts.onLanguageChange(select.value)
    setMenu(false)
    // Confirm the change and reinforce that it is scoped to this meeting only.
    showToast(`🌐 ${langText.textContent} · only this meeting`)
  })
  syncLangText()

  langRow.append(langGlyph, langText, caret, select)

  // --- pinned-language buttons ------------------------------------------------
  // A dropdown is the wrong shape for the thing people actually do in a call:
  // switch between the two or three languages they meet in. Those get a button
  // each, one click, current one lit. The row above stays for everything else,
  // so an unexpected language is never unreachable — a picker that can only
  // offer three is a picker that fails the meeting it did not predict.
  const favourites = (opts.favouriteLanguages ?? [])
    .map((value) => CAPTION_LANGUAGES.find((l) => l.value === value))
    .filter((l): l is (typeof CAPTION_LANGUAGES)[number] => Boolean(l))
    .slice(0, MAX_FAVOURITE_LANGUAGES)

  const langButtons = new Map<string, HTMLButtonElement>()
  const syncLangButtons = (): void => {
    for (const [value, button] of langButtons) {
      button.setAttribute("aria-pressed", String(value === select.value))
    }
  }

  for (const lang of favourites) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "pn-pill pn-lang"
    button.dataset.pn = `lang-${lang.value}`
    button.title = `Plática Notes: record this meeting in ${lang.label}`
    // Flag AND code together: Windows renders no flag for a regional-indicator
    // pair, so the code is the label there and a nicety here.
    const flag = document.createElement("span")
    flag.textContent = lang.flag
    const code = document.createElement("span")
    code.className = "pn-lang-code"
    code.textContent = lang.code
    button.append(flag, code)
    button.addEventListener("click", () => {
      if (select.value === lang.value) return
      select.value = lang.value
      syncLangText()
      syncLangButtons()
      opts.onLanguageChange(lang.value)
      showToast(`${lang.flag} ${lang.label} · only this meeting`)
    })
    langButtons.set(lang.value, button)
  }

  // --- transcript row: toggles the live transcript panel. Says which way it will
  // go rather than colouring itself; the caller keeps it in sync via
  // setTranscriptActive. ---
  let transcriptActive = false
  const transcriptRow = document.createElement("button")
  transcriptRow.type = "button"
  transcriptRow.className = "pn-row"
  transcriptRow.dataset.pn = "transcript"
  transcriptRow.title = "Show or hide the live transcript panel"
  const transcriptGlyph = document.createElement("span")
  transcriptGlyph.textContent = "📄"
  const transcriptLabel = document.createElement("span")
  transcriptRow.append(transcriptGlyph, transcriptLabel)
  const renderTranscript = (): void => {
    transcriptLabel.textContent = transcriptActive ? "Hide transcript" : "Show transcript"
  }
  transcriptRow.addEventListener("click", () => {
    opts.onToggleTranscript()
    // A menu that stays open after its row has done its job is a menu the user
    // has to dismiss by hand before they can see what they just changed.
    setMenu(false)
  })
  renderTranscript()

  // --- privacy row: the toggle lives in the menu, but the state it sets shows on
  // the recording pill (the lock), so a private meeting is never quietly private. ---
  let isPrivate = opts.initialPrivate
  const privacyRow = document.createElement("button")
  privacyRow.type = "button"
  privacyRow.className = "pn-row"
  privacyRow.dataset.pn = "private"
  privacyRow.title = "Write this meeting to your private folder instead"
  const privacyGlyph = document.createElement("span")
  privacyGlyph.textContent = "🔒"
  const privacyLabel = document.createElement("span")
  privacyLabel.textContent = "Mark private"
  const privacyState = document.createElement("span")
  privacyState.className = "pn-row-state"
  privacyRow.append(privacyGlyph, privacyLabel, privacyState)
  const renderPrivacy = (): void => {
    privacyState.textContent = isPrivate ? "on" : "off"
    privacyRow.classList.toggle("is-on", isPrivate)
    privacyRow.setAttribute("aria-pressed", String(isPrivate))
  }
  privacyRow.addEventListener("click", () => {
    isPrivate = !isPrivate
    renderPrivacy()
    // The lock lives on the recording pill; keep it in step. Safe to call here —
    // by click time both renderers exist.
    renderRecording()
    opts.onPrivateChange(isPrivate)
    setMenu(false)
  })
  renderPrivacy()

  // --- recording pill: On FILLS the pill red — the universal "recording live"
  // indicator; Off fills it grey (muted/stopped). A stopped recording is
  // impossible to miss. The elapsed clock rides along as the liveness signal: a
  // clock that has stopped moving says something is wrong before any warning can.
  // Toggling flips the flag via onRecordingChange. ---
  let recording = opts.initialRecording
  const recordingPill = document.createElement("button")
  recordingPill.type = "button"
  recordingPill.className = "pn-pill pn-rec"
  recordingPill.dataset.pn = "recording"
  recordingPill.title = "Plática Notes: pause or resume capturing this meeting"
  const recDot = document.createElement("span")
  recDot.className = "pn-rec-dot"
  const recLabel = document.createElement("span")
  const recClock = document.createElement("span")
  recClock.className = "pn-clock"
  const recLock = document.createElement("span")
  recLock.className = "pn-lock"
  recordingPill.append(recDot, recLabel, recClock, recLock)

  const renderRecording = (): void => {
    recLabel.textContent = recording ? "Recording" : "Paused"
    recordingPill.classList.toggle("is-paused", !recording)
    // Carries the privacy state too, now that the toggle itself lives in the
    // menu: hiding a control is fine, hiding what it is currently doing is not.
    recLock.textContent = isPrivate ? "🔒" : ""
    recClock.textContent = opts.startedAt ? elapsed(opts.startedAt) : ""
  }
  recordingPill.addEventListener("click", () => {
    recording = !recording
    renderRecording()
    opts.onRecordingChange(recording)
  })
  renderRecording()
  // One second is the resolution of the clock, and the only thing that repaints.
  const clockTimer = opts.startedAt ? setInterval(renderRecording, 1000) : undefined

  // --- wipe row: destructive clean-slate for the current meeting. Two-click
  // confirm inline (no native dialog): first click arms for 4s, second click within
  // the window fires onPurge. Reverts on timeout. ---
  let wipeArmed = false
  let wipeTimer: ReturnType<typeof setTimeout> | undefined
  const wipeRow = document.createElement("button")
  wipeRow.type = "button"
  wipeRow.className = "pn-row pn-row-danger"
  wipeRow.dataset.pn = "wipe"
  wipeRow.title = "Wipe everything captured in this meeting so far"
  const wipeGlyph = document.createElement("span")
  wipeGlyph.textContent = "🗑"
  const wipeLabel = document.createElement("span")
  wipeRow.append(wipeGlyph, wipeLabel)
  const disarmWipe = (): void => {
    wipeArmed = false
    if (wipeTimer) clearTimeout(wipeTimer)
    wipeTimer = undefined
    wipeLabel.textContent = "Wipe what was captured"
    wipeRow.classList.remove("is-armed")
  }
  wipeRow.addEventListener("click", () => {
    if (!wipeArmed) {
      wipeArmed = true
      wipeLabel.textContent = "Click again to wipe · cannot be undone"
      wipeRow.classList.add("is-armed")
      wipeTimer = setTimeout(disarmWipe, 4000)
      return
    }
    disarmWipe()
    opts.onPurge()
    setMenu(false)
    showToast("Wiped everything captured in this meeting so far.")
  })
  disarmWipe()

  // --- overflow menu ---------------------------------------------------------
  // The bar sits on top of somebody's meeting, so every pill has to earn its
  // place. Two things do: whether it is recording, and in which language —
  // getting either wrong ruins the transcript, and both need one click. The rest
  // moves behind a menu.
  //
  // Wipe is the strongest case, and not on grounds of tidiness: it is the only
  // control here that destroys what has been captured, and it sat one stray
  // elbow away from the language buttons. Its two-click confirm still applies.
  const menu = document.createElement("div")
  menu.className = "pn-menu"
  menu.setAttribute("role", "menu")

  // The chords were documented only in the popup and in Settings, which is not
  // where the question comes up.
  const foot = document.createElement("p")
  foot.className = "pn-menu-foot"
  // Each chord and its label is one atomic unit: the footer wraps on a narrow
  // window, and a wrap that lands between a key cap and the words it belongs to
  // reads as a different sentence.
  const chord = (keys: string, what: string): HTMLSpanElement => {
    const unit = document.createElement("span")
    unit.className = "pn-chord"
    const cap = document.createElement("span")
    cap.className = "pn-key"
    cap.textContent = keys
    const label = document.createElement("span")
    label.textContent = what
    unit.append(cap, label)
    return unit
  }
  foot.append(chord(BOOKMARK_CHORD, "marks a moment"), chord(HIDE_CHORD, "hides the controls"))

  menu.append(langRow, transcriptRow, privacyRow, wipeRow, foot)

  const moreButton = document.createElement("button")
  moreButton.type = "button"
  moreButton.className = "pn-pill pn-more"
  moreButton.dataset.pn = "more"
  moreButton.setAttribute("aria-haspopup", "menu")
  moreButton.setAttribute("aria-expanded", "false")
  moreButton.setAttribute("aria-label", "Plática Notes: more options")
  moreButton.title = "Plática Notes: more options"
  moreButton.textContent = "⋯"

  // Arrow keys walk the menu, so it is usable without a mouse. The language row's
  // focusable element is its transparent <select>, which is also what opens the
  // list, so it takes that row's place in the sequence.
  const menuItems = (): HTMLElement[] => [select, transcriptRow, privacyRow, wipeRow]

  let menuOpen = false
  function setMenu(open: boolean, focusFirst = false): void {
    menuOpen = open
    menu.classList.toggle("is-open", open)
    moreButton.setAttribute("aria-expanded", String(open))
    if (!open) disarmWipe()
    if (open && focusFirst) menuItems()[0]?.focus()
  }
  moreButton.addEventListener("click", (event) => {
    event.stopPropagation()
    setMenu(!menuOpen)
  })
  moreButton.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setMenu(true, true)
    }
  })
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    // A <select> owns the arrow keys when its list is open; when it is closed the
    // browser would change the selection instead of moving focus, which would
    // silently resubscribe capture. Moving focus is the safer reading here.
    event.preventDefault()
    const items = menuItems()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === "ArrowDown" ? 1 : -1
    items[(at + step + items.length) % items.length]?.focus()
  })
  // Any click outside closes it, as does Escape. Both listeners are removed with
  // the container on unmount.
  const onDocClick = (event: MouseEvent): void => {
    if (menuOpen && !container.contains(event.target as Node)) setMenu(false)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (menuOpen && event.key === "Escape") {
      setMenu(false)
      moreButton.focus()
    }
  }
  document.addEventListener("click", onDocClick, true)
  document.addEventListener("keydown", onKey, true)

  const moreWrap = document.createElement("div")
  moreWrap.className = "pn-more-wrap"
  moreWrap.append(moreButton, menu)

  syncLangButtons()
  container.append(recordingPill, ...langButtons.values(), moreWrap)
  document.documentElement.appendChild(container)
  return {
    unmount: () => {
      document.removeEventListener("click", onDocClick, true)
      document.removeEventListener("keydown", onKey, true)
      if (clockTimer) clearInterval(clockTimer)
      if (wipeTimer) clearTimeout(wipeTimer)
      container.remove()
    },
    setTranscriptActive: (active: boolean) => {
      transcriptActive = active
      renderTranscript()
    },
    // Set the row's language without firing its change event, for when the
    // start-of-meeting prompt drives the change, so the row stays in sync without
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
      syncLangButtons()
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
  const labelFor = (value: string): string =>
    CAPTION_LANGUAGES.find(l => l.value === value)?.label ?? value

  const card = document.createElement("div")
  card.className = "pn-prompt"
  card.setAttribute("role", "dialog")
  // Non-modal, and it deliberately does NOT take focus. It appears the moment a
  // call is joined, where stealing focus would fight Meet's own controls and
  // could swallow a keystroke aimed at the mic.
  card.setAttribute("aria-modal", "false")
  card.setAttribute("aria-label", "Recording language")
  registerUiEl(card)

  const title = document.createElement("p")
  title.className = "pn-prompt-title"
  title.textContent = "Recording language"

  const body = document.createElement("p")
  body.className = "pn-prompt-body"
  body.textContent =
    `This meeting is being recorded in ${labelFor(opts.initialLanguage)}. ` +
    "If it's in another language, switch now — otherwise the captions come out garbled."

  const select = document.createElement("select")
  select.className = "pn-select"
  select.setAttribute("aria-label", "Caption language for this meeting")
  // Pinned languages first, then a disabled divider, then the rest. The order is
  // the whole signal: a divider is a line, not a header row, so it dodges the
  // unreadable-grey problem described above while still showing where the
  // shortlist ends.
  for (const lang of orderedLanguages(CAPTION_LANGUAGES, opts.favouriteLanguages)) {
    const opt = document.createElement("option")
    opt.value = lang.value
    opt.textContent = lang.label
    if (isDivider(lang)) opt.disabled = true
    select.appendChild(opt)
  }
  if (![...select.options].some(o => o.value === opts.initialLanguage)) {
    const opt = document.createElement("option")
    opt.value = opts.initialLanguage
    opt.textContent = opts.initialLanguage
    select.appendChild(opt)
  }
  select.value = opts.initialLanguage

  const dismiss = (): void => card.remove()
  // Picking a language in the dropdown applies it and closes the prompt in one
  // step — `change` only fires on a real switch, so no separate confirm click is
  // needed. Capture resubscribes via onPick.
  select.addEventListener("change", () => { opts.onPick(select.value); dismiss() })

  // The default is already what capture is using; this is the one-click path when
  // the language is already right — confirm and close, no resubscribe.
  const keep = document.createElement("button")
  keep.type = "button"
  keep.className = "pn-btn"
  keep.textContent = `Keep ${labelFor(opts.initialLanguage)}`
  keep.addEventListener("click", dismiss)

  const noAsk = document.createElement("button")
  noAsk.type = "button"
  noAsk.className = "pn-btn-quiet"
  noAsk.textContent = "Don't ask again"
  noAsk.addEventListener("click", () => { opts.onDisableAsking(); dismiss() })

  card.append(title, body, select, keep, noAsk)
  document.documentElement.appendChild(card)
  return { unmount: dismiss }
}
