import { CAPTION_LANGUAGES, MAX_FAVOURITE_LANGUAGES } from "../../shared/languages"
import { mountLanguageChips } from "../shared/language-chips"
import { monthFolder, sanitizeFolder } from "../../shared/paths"
import { ACTIVE_TABS_KEY, getLocal, getSettings, hasActiveMeeting, saveSettings } from "../../shared/storage"
import { DEFAULT_SETTINGS } from "../../shared/types"

const captionLanguage = document.querySelector<HTMLSelectElement>("#caption-language")!
const favouriteLanguages = document.querySelector<HTMLDivElement>("#favourite-languages")!
const activeMeetingNote = document.querySelector<HTMLParagraphElement>("#active-meeting-note")!
const privateDefault = document.querySelector<HTMLInputElement>("#private-default")!
const debugLog = document.querySelector<HTMLInputElement>("#debug-log")!
const captionAlternatives = document.querySelector<HTMLInputElement>("#caption-alternatives")!
const mergeRejoins = document.querySelector<HTMLInputElement>("#merge-rejoins")!
const askLanguage = document.querySelector<HTMLInputElement>("#ask-language")!
const retention = document.querySelector<HTMLInputElement>("#retention")!
const folderPublic = document.querySelector<HTMLInputElement>("#folder-public")!
const folderPrivate = document.querySelector<HTMLInputElement>("#folder-private")!
const folderDebug = document.querySelector<HTMLInputElement>("#folder-debug")!
const savedFlag = document.querySelector<HTMLElement>("#saved-flag")!

// Build stamp shown at the bottom of the page. typeof-guarded so vitest and any
// non-build eval fall back to "dev" instead of throwing ReferenceError.
const buildVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
const buildCommit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"
const buildInfo = document.querySelector<HTMLParagraphElement>("#build-info")
if (buildInfo) buildInfo.textContent = `v${buildVersion} (${buildCommit})`

// Both chords are the same physical key everywhere (Alt on Windows/Linux is the
// Option key on macOS, and both set event.altKey), so only the label differs.
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)
for (const [id, mac, other] of [
  ["#bookmark-shortcut", "⌥⇧B", "Alt+Shift+B"],
  ["#hide-shortcut", "⌥⇧H", "Alt+Shift+H"],
] as const) {
  const node = document.querySelector(id)
  if (node) node.textContent = isMac ? mac : other
}

for (const lang of CAPTION_LANGUAGES) {
  const opt = document.createElement("option")
  opt.value = lang.value
  opt.textContent = lang.label
  captionLanguage.appendChild(opt)
}

// --- write acknowledgement ---------------------------------------------------
// Every control here saves the moment it changes, which used to happen in total
// silence. One shared flash, so "did that take?" is never a question.
let savedTimer: ReturnType<typeof setTimeout> | undefined
function save(patch: Parameters<typeof saveSettings>[0]): void {
  void saveSettings(patch).then(() => {
    savedFlag.classList.add("is-on")
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => savedFlag.classList.remove("is-on"), 1600)
    syncSummaries()
  })
}

// The chip picker is shared with the first-run page (see pages/shared).
const chips = mountLanguageChips(favouriteLanguages, (values) => save({ favouriteLanguages: values }))

// --- folder previews ---------------------------------------------------------
// A folder is not free text: the downloader sanitises every segment and drops
// "..", so a path can silently become a different path. Showing the result while
// it is typed is the difference between preventing that and explaining it later.
const PREVIEWS = [
  [folderPublic, "#preview-public", DEFAULT_SETTINGS.folderPublic] as const,
  [folderPrivate, "#preview-private", DEFAULT_SETTINGS.folderPrivate] as const,
  [folderDebug, "#preview-debug", DEFAULT_SETTINGS.folderDebug] as const,
]

function renderPreview(input: HTMLInputElement, target: string, fallback: string): void {
  const node = document.querySelector<HTMLElement>(target)
  if (!node) return
  const typed = input.value.trim()
  const resolved = sanitizeFolder(typed, fallback)
  const rewritten = typed !== resolved

  const folder = document.createElement("strong")
  folder.textContent = resolved
  node.replaceChildren(
    document.createTextNode("Downloads/"),
    folder,
    document.createTextNode(`/${monthFolder(new Date().toISOString())}/`),
  )
  if (rewritten) {
    node.append(document.createTextNode(typed === "" ? "  (empty, so the default is used)" : "  (rewritten)"))
  }
  node.classList.toggle("is-rewritten", rewritten)
  input.setAttribute("aria-invalid", String(rewritten))
}

function renderAllPreviews(): void {
  for (const [input, target, fallback] of PREVIEWS) renderPreview(input, target, fallback)
}

// --- group summaries ---------------------------------------------------------
// Each heading carries its group's current value, so the page can be read as a
// status board before it is used as a form.
function syncSummaries(): void {
  const set = (id: string, text: string): void => {
    const node = document.querySelector<HTMLElement>(id)
    if (node) node.textContent = text
  }
  set("#v-recording", `${captionLanguage.value} · ${privateDefault.checked ? "private" : "public"}`)
  set("#v-languages", `${chips.count()} of ${MAX_FAVOURITE_LANGUAGES} pinned`)
  set("#v-files", sanitizeFolder(folderPublic.value.trim(), DEFAULT_SETTINGS.folderPublic))
  set(
    "#v-file",
    [captionAlternatives.checked ? "alternatives" : null, mergeRejoins.checked ? "merge" : null]
      .filter(Boolean)
      .join(" · ") || "plain",
  )
  set("#v-history", `keeps ${retention.value}`)
  set("#v-trouble", debugLog.checked ? "logging on" : "logging off")
}

async function init(): Promise<void> {
  const settings = await getSettings()
  captionLanguage.value = settings.captionLanguage
  if (captionLanguage.value === "") {
    // The stored value is not among the built-in <option>s (future language tag,
    // manually set value, etc.). Append a synthetic option so the UI shows the
    // truth rather than going blank; the stored setting is NOT overwritten.
    const opt = document.createElement("option")
    opt.value = settings.captionLanguage
    opt.textContent = settings.captionLanguage
    captionLanguage.appendChild(opt)
    captionLanguage.value = settings.captionLanguage
  }
  privateDefault.checked = settings.privateByDefault
  debugLog.checked = settings.debugLog
  captionAlternatives.checked = settings.captionAlternatives
  mergeRejoins.checked = settings.mergeRejoins
  askLanguage.checked = settings.askLanguageEachMeeting
  retention.value = String(settings.retentionLimit)
  chips.setChosen(settings.favouriteLanguages)
  folderPublic.value = settings.folderPublic
  folderPrivate.value = settings.folderPrivate
  folderDebug.value = settings.folderDebug
  renderAllPreviews()
  syncSummaries()
  await refreshActiveMeetingNote()
}

// Show the note only while a meeting is recording, so it's clear a default-language
// change won't retarget the live meeting. Kept live via the storage listener below
// in case a meeting starts or ends while this page is open.
async function refreshActiveMeetingNote(): Promise<void> {
  activeMeetingNote.hidden = !hasActiveMeeting(await getLocal<number[]>(ACTIVE_TABS_KEY))
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ACTIVE_TABS_KEY]) void refreshActiveMeetingNote()
})

captionLanguage.addEventListener("change", () => {
  save({ captionLanguage: captionLanguage.value })
})

privateDefault.addEventListener("change", () => {
  save({ privateByDefault: privateDefault.checked })
})

debugLog.addEventListener("change", () => {
  save({ debugLog: debugLog.checked })
})

captionAlternatives.addEventListener("change", () => {
  save({ captionAlternatives: captionAlternatives.checked })
})

mergeRejoins.addEventListener("change", () => {
  save({ mergeRejoins: mergeRejoins.checked })
})

askLanguage.addEventListener("change", () => {
  save({ askLanguageEachMeeting: askLanguage.checked })
})

// Clamped rather than validated-and-refused: a number field is easy to empty by
// accident, and a retention limit of 0 would throw away every meeting.
retention.addEventListener("change", () => {
  const parsed = Number.parseInt(retention.value, 10)
  const limit = Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : DEFAULT_SETTINGS.retentionLimit
  retention.value = String(limit)
  save({ retentionLimit: limit })
})

for (const [input] of PREVIEWS) {
  // Preview on every keystroke; persist once the field is left, as before.
  input.addEventListener("input", () => renderAllPreviews())
}

folderPublic.addEventListener("change", () => {
  save({ folderPublic: folderPublic.value.trim() })
})

folderPrivate.addEventListener("change", () => {
  save({ folderPrivate: folderPrivate.value.trim() })
})

folderDebug.addEventListener("change", () => {
  save({ folderDebug: folderDebug.value.trim() })
})

void init()
