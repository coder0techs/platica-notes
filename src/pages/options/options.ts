import { CAPTION_LANGUAGES } from "../../shared/languages"
import { ACTIVE_TABS_KEY, getLocal, getSettings, hasActiveMeeting, saveSettings } from "../../shared/storage"

const captionLanguage = document.querySelector<HTMLSelectElement>("#caption-language")!
const activeMeetingNote = document.querySelector<HTMLParagraphElement>("#active-meeting-note")!
const privateDefault = document.querySelector<HTMLInputElement>("#private-default")!
const debugLog = document.querySelector<HTMLInputElement>("#debug-log")!
const captionAlternatives = document.querySelector<HTMLInputElement>("#caption-alternatives")!
const mergeRejoins = document.querySelector<HTMLInputElement>("#merge-rejoins")!
const askLanguage = document.querySelector<HTMLInputElement>("#ask-language")!
const folderPublic = document.querySelector<HTMLInputElement>("#folder-public")!
const folderPrivate = document.querySelector<HTMLInputElement>("#folder-private")!
const folderDebug = document.querySelector<HTMLInputElement>("#folder-debug")!

// Build stamp shown at the bottom of the page. typeof-guarded so vitest and any
// non-build eval fall back to "dev" instead of throwing ReferenceError.
const buildVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
const buildCommit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"
const buildInfo = document.querySelector<HTMLParagraphElement>("#build-info")
if (buildInfo) buildInfo.textContent = `v${buildVersion} (${buildCommit})`

// The bookmark chord is the same physical key everywhere (Alt on Windows/Linux is
// the Option key on macOS — both set event.altKey), so only the label differs.
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)
const bookmarkShortcut = document.querySelector("#bookmark-shortcut")
if (bookmarkShortcut) bookmarkShortcut.textContent = isMac ? "⌥⇧B" : "Alt+Shift+B"

for (const lang of CAPTION_LANGUAGES) {
  const opt = document.createElement("option")
  opt.value = lang.value
  opt.textContent = lang.label
  captionLanguage.appendChild(opt)
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
  folderPublic.value = settings.folderPublic
  folderPrivate.value = settings.folderPrivate
  folderDebug.value = settings.folderDebug
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
  void saveSettings({ captionLanguage: captionLanguage.value })
})

privateDefault.addEventListener("change", () => {
  void saveSettings({ privateByDefault: privateDefault.checked })
})

debugLog.addEventListener("change", () => {
  void saveSettings({ debugLog: debugLog.checked })
})

captionAlternatives.addEventListener("change", () => {
  void saveSettings({ captionAlternatives: captionAlternatives.checked })
})

mergeRejoins.addEventListener("change", () => {
  void saveSettings({ mergeRejoins: mergeRejoins.checked })
})

askLanguage.addEventListener("change", () => {
  void saveSettings({ askLanguageEachMeeting: askLanguage.checked })
})

folderPublic.addEventListener("change", () => {
  void saveSettings({ folderPublic: folderPublic.value.trim() })
})

folderPrivate.addEventListener("change", () => {
  void saveSettings({ folderPrivate: folderPrivate.value.trim() })
})

folderDebug.addEventListener("change", () => {
  void saveSettings({ folderDebug: folderDebug.value.trim() })
})

void init()
