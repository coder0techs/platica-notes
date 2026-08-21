import { CAPTION_LANGUAGES } from "../../shared/languages"
import { getSettings, saveSettings } from "../../shared/storage"
import { mountLanguageChips } from "../shared/language-chips"

const captionLanguage = document.querySelector<HTMLSelectElement>("#caption-language")!
const favouriteLanguages = document.querySelector<HTMLDivElement>("#favourite-languages")!
const savedFlag = document.querySelector<HTMLElement>("#saved-flag")!
const start = document.querySelector<HTMLButtonElement>("#start")!

for (const lang of CAPTION_LANGUAGES) {
  const opt = document.createElement("option")
  opt.value = lang.value
  opt.textContent = lang.label
  captionLanguage.appendChild(opt)
}

// Same acknowledgement as the settings page: these controls save on change, and a
// first-run page that swallows the first thing someone does is a bad first
// impression as well as a usability bug.
let savedTimer: ReturnType<typeof setTimeout> | undefined
function save(patch: Parameters<typeof saveSettings>[0]): Promise<void> {
  return saveSettings(patch).then(() => {
    savedFlag.classList.add("is-on")
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => savedFlag.classList.remove("is-on"), 1600)
  })
}

const chips = mountLanguageChips(favouriteLanguages, (values) => void save({ favouriteLanguages: values }))

async function init(): Promise<void> {
  const settings = await getSettings()
  captionLanguage.value = settings.captionLanguage
  chips.setChosen(settings.favouriteLanguages)
}

// Persist on every change so the choice is saved even if the user closes the tab
// without clicking the button. The button is just an explicit "done".
captionLanguage.addEventListener("change", () => {
  void save({ captionLanguage: captionLanguage.value })
})

start.addEventListener("click", () => {
  // Leaves them on the history page rather than on a closed tab: it is where the
  // first transcript will show up, and the button says so.
  void save({ captionLanguage: captionLanguage.value }).then(() => {
    window.location.href = "history.html"
  })
})

void init()
