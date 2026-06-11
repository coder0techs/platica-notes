import { getSettings, saveSettings } from "../../shared/storage"

const captionLanguage = document.querySelector<HTMLSelectElement>("#caption-language")!
const privateDefault = document.querySelector<HTMLInputElement>("#private-default")!

async function init(): Promise<void> {
  const settings = await getSettings()
  captionLanguage.value = settings.captionLanguage
  privateDefault.checked = settings.privateByDefault
}

captionLanguage.addEventListener("change", () => {
  void saveSettings({ captionLanguage: captionLanguage.value })
})

privateDefault.addEventListener("change", () => {
  void saveSettings({ privateByDefault: privateDefault.checked })
})

void init()
