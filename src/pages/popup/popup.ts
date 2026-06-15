import { CAPTION_LANGUAGES } from "../../shared/languages"
import { getSettings, saveSettings } from "../../shared/storage"

const captionLanguage = document.querySelector<HTMLSelectElement>("#caption-language")!
const privateDefault = document.querySelector<HTMLInputElement>("#private-default")!
const debugLog = document.querySelector<HTMLInputElement>("#debug-log")!

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

void init()
