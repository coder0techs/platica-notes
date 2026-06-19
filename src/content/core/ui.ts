import { CAPTION_LANGUAGES } from "../../shared/languages"

const PULSE_ID = "platica-pulse"

/** Brief top-bar flash confirming a storage write happened. */
export function pulseActivity(): void {
  let bar = document.getElementById(PULSE_ID)
  if (!bar) {
    bar = document.createElement("div")
    bar.id = PULSE_ID
    bar.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:3px;z-index:2147483647;" +
      "pointer-events:none;transition:background-color .3s ease-in;background-color:transparent;"
    document.documentElement.appendChild(bar)
  }
  bar.style.backgroundColor = "#6750a4"
  setTimeout(() => { bar.style.backgroundColor = "transparent" }, 1500)
}

export function showToast(message: string): void {
  const toast = document.createElement("div")
  toast.textContent = message
  // Sits below the persistent top-center controls (top:12px) so it never overlaps.
  toast.style.cssText =
    "position:fixed;top:64px;left:50%;transform:translateX(-50%);background:#1f1f1f;color:#fff;" +
    "padding:10px 16px;border-radius:8px;font:14px system-ui;z-index:2147483647;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.3);"
  document.documentElement.appendChild(toast)
  setTimeout(() => toast.remove(), 8000)
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
  onLanguageChange: (language: string) => void
  onPrivateChange: (isPrivate: boolean) => void
  onToggleTranscript: () => void
}): { unmount: () => void; setTranscriptActive: (active: boolean) => void } {
  const container = document.createElement("div")
  container.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:2147483647;"

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
  for (const lang of CAPTION_LANGUAGES) {
    const opt = document.createElement("option")
    opt.value = lang.value
    opt.textContent = lang.label
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

  container.append(langPill, transcriptPill, privacyPill)
  document.documentElement.appendChild(container)
  return {
    unmount: () => container.remove(),
    setTranscriptActive: (active: boolean) => {
      transcriptActive = active
      renderTranscript()
    },
  }
}
