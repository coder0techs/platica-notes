import { CAPTION_LANGUAGES, MAX_FAVOURITE_LANGUAGES } from "../../shared/languages"

/**
 * The pinned-language picker: a toggle button per language showing the same flag
 * and code as the in-meeting buttons it turns on, so the setting looks like the
 * thing it controls. Shared by the settings page and the first-run page: the
 * shortlist is the setting that makes the in-meeting controls worth using, and it
 * should not first become visible only to whoever goes looking in Settings.
 *
 * Chosen order follows CAPTION_LANGUAGES rather than click order: a stable
 * shortlist beats one that reshuffles when a language is switched off and on
 * again. At the cap the remaining chips go visibly inert rather than failing on
 * click, and never silently evict someone's earlier choice.
 */
export function mountLanguageChips(
  host: HTMLElement,
  onChange: (chosen: string[]) => void,
): { setChosen: (values: string[]) => void; count: () => number } {
  const buttons: HTMLButtonElement[] = []
  const chosen = new Set<string>()

  const inListOrder = (): string[] =>
    CAPTION_LANGUAGES.filter((l) => chosen.has(l.value)).map((l) => l.value)

  const sync = (): void => {
    const full = chosen.size >= MAX_FAVOURITE_LANGUAGES
    for (const button of buttons) {
      const on = chosen.has(button.value)
      button.setAttribute("aria-pressed", String(on))
      button.classList.toggle("is-on", on)
      button.disabled = full && !on
    }
  }

  for (const lang of CAPTION_LANGUAGES) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "lang-chip"
    button.value = lang.value
    button.setAttribute("aria-pressed", "false")
    button.title = lang.label

    const flag = document.createElement("span")
    flag.className = "lang-chip-flag"
    // Flag and code together: Windows renders no flag for a regional-indicator
    // pair, so the code carries the meaning there.
    flag.textContent = lang.flag
    const code = document.createElement("span")
    code.className = "lang-chip-code"
    code.textContent = lang.code
    const name = document.createElement("span")
    name.className = "lang-chip-name"
    name.textContent = lang.label

    button.append(flag, code, name)
    host.append(button)
    buttons.push(button)

    button.addEventListener("click", () => {
      if (chosen.has(lang.value)) chosen.delete(lang.value)
      else if (chosen.size < MAX_FAVOURITE_LANGUAGES) chosen.add(lang.value)
      else return
      sync()
      onChange(inListOrder())
    })
  }

  return {
    setChosen: (values: string[]) => {
      chosen.clear()
      for (const value of values.slice(0, MAX_FAVOURITE_LANGUAGES)) chosen.add(value)
      sync()
    },
    count: () => chosen.size,
  }
}
