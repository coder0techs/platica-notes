import { CAPTION_LANGUAGES } from "../../shared/languages"
import { getSettings, saveSettings } from "../../shared/storage"

const captionLanguage = document.querySelector<HTMLSelectElement>("#caption-language")!
const start = document.querySelector<HTMLButtonElement>("#start")!

for (const lang of CAPTION_LANGUAGES) {
  const opt = document.createElement("option")
  opt.value = lang.value
  opt.textContent = lang.label
  captionLanguage.appendChild(opt)
}

async function init(): Promise<void> {
  const settings = await getSettings()
  captionLanguage.value = settings.captionLanguage
}

// Persist on every change so the choice is saved even if the user closes the tab
// without clicking the button. The button is just an explicit "done".
captionLanguage.addEventListener("change", () => {
  void saveSettings({ captionLanguage: captionLanguage.value })
})

start.addEventListener("click", () => {
  // window.close() is blocked for a tab the extension opened (not script-opened),
  // so close this tab through the tabs API instead. Neither call needs the "tabs"
  // permission — it only gates reading sensitive tab properties.
  void saveSettings({ captionLanguage: captionLanguage.value }).then(() => {
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id !== undefined) void chrome.tabs.remove(tab.id)
    })
  })
})

void init()
