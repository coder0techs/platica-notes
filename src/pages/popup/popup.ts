import { getSettings, saveSettings } from "../../shared/storage"

const hideUi = document.querySelector<HTMLInputElement>("#hide-ui")!
const openSettings = document.querySelector<HTMLAnchorElement>("#open-settings")!

// Build stamp shown at the bottom of the popup. typeof-guarded so vitest and
// any non-build eval fall back to "dev" instead of throwing ReferenceError.
const buildVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
const buildCommit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"
const buildInfo = document.querySelector<HTMLParagraphElement>("#build-info")
if (buildInfo) buildInfo.textContent = `v${buildVersion} (${buildCommit})`

// The hide-UI chord is the same physical key everywhere (Alt on Windows/Linux is
// the Option key on macOS — both set event.altKey), so only the label differs.
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)
const hideShortcut = document.querySelector("#hide-ui-shortcut")
if (hideShortcut) hideShortcut.textContent = isMac ? "⌥⇧H" : "Alt+Shift+H"

openSettings.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage()
})

async function init(): Promise<void> {
  const settings = await getSettings()
  hideUi.checked = settings.hideUi
}

hideUi.addEventListener("change", () => {
  void saveSettings({ hideUi: hideUi.checked })
})

void init()
