import { CAPTION_LANGUAGES } from "../../shared/languages"
import { getSettings, saveSettings } from "../../shared/storage"

const captionLanguage = document.querySelector<HTMLSelectElement>("#caption-language")!
const privateDefault = document.querySelector<HTMLInputElement>("#private-default")!
const debugLog = document.querySelector<HTMLInputElement>("#debug-log")!
const folderPublic = document.querySelector<HTMLInputElement>("#folder-public")!
const folderPrivate = document.querySelector<HTMLInputElement>("#folder-private")!
const folderDebug = document.querySelector<HTMLInputElement>("#folder-debug")!

// Build stamp shown at the bottom of the popup. typeof-guarded so vitest and
// any non-build eval fall back to "dev" instead of throwing ReferenceError.
const buildVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
const buildCommit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"
const buildInfo = document.querySelector<HTMLParagraphElement>("#build-info")
if (buildInfo) buildInfo.textContent = `v${buildVersion} (${buildCommit})`

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
  folderPublic.value = settings.folderPublic
  folderPrivate.value = settings.folderPrivate
  folderDebug.value = settings.folderDebug
}

captionLanguage.addEventListener("change", () => {
  void saveSettings({ captionLanguage: captionLanguage.value })
})

privateDefault.addEventListener("change", () => {
  void saveSettings({ privateByDefault: privateDefault.checked })
})

debugLog.addEventListener("change", () => {
  void saveSettings({ debugLog: debugLog.checked })
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
