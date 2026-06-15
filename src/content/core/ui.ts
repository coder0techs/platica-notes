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
 * group: a caption-language select and a privacy toggle. Returns an unmount.
 */
export function mountMeetingControls(opts: {
  initialLanguage: string
  initialPrivate: boolean
  onLanguageChange: (language: string) => void
  onPrivateChange: (isPrivate: boolean) => void
}): () => void {
  const container = document.createElement("div")
  container.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:2147483647;"

  // --- language pill: a visual layer (glyph + label + caret) with a transparent
  // native <select> stretched over the WHOLE pill, so a click anywhere on the pill
  // opens the OS dropdown (not just the narrow text zone). ---
  const langPill = document.createElement("div")
  langPill.style.cssText = PILL_BASE + "position:relative;"
  langPill.title = "Plática Notes: caption language to capture"
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

  // --- privacy pill: same dark style; the mode is conveyed by text color —
  // Public in red (goes to the synced folder), Private in green (local-only). ---
  let isPrivate = opts.initialPrivate
  const privacyPill = document.createElement("button")
  privacyPill.type = "button"
  privacyPill.style.cssText = PILL_BASE
  privacyPill.title = "Plática Notes: where this transcript may go"
  const renderPrivacy = () => {
    privacyPill.textContent = isPrivate ? "🔒 Private" : "☁️ Public"
    privacyPill.style.color = isPrivate ? "#81c995" : "#f28b82"
  }
  privacyPill.addEventListener("mouseenter", () => { privacyPill.style.background = PILL_BG_HOVER })
  privacyPill.addEventListener("mouseleave", () => { privacyPill.style.background = PILL_BG })
  privacyPill.addEventListener("click", () => {
    isPrivate = !isPrivate
    renderPrivacy()
    opts.onPrivateChange(isPrivate)
  })
  renderPrivacy()

  container.append(langPill, privacyPill)
  document.documentElement.appendChild(container)
  return () => container.remove()
}
