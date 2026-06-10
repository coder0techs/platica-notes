import { getSettings, saveSettings } from "../../shared/storage"

const hideCaptions = document.querySelector<HTMLInputElement>("#hide-captions")!
const privateDefault = document.querySelector<HTMLInputElement>("#private-default")!

async function init(): Promise<void> {
  const settings = await getSettings()
  hideCaptions.checked = settings.hideCaptionsOverlay
  privateDefault.checked = settings.privateByDefault
}

hideCaptions.addEventListener("change", () => {
  void saveSettings({ hideCaptionsOverlay: hideCaptions.checked })
})

privateDefault.addEventListener("change", () => {
  void saveSettings({ privateByDefault: privateDefault.checked })
})

void init()
