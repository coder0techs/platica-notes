export interface LanguageOption {
  value: string
  label: string
}

// Single source of truth for the caption-language picker, shared by the popup
// and the on-screen Meet controls. Values are BCP 47 tags passed to Meet's
// caption stream subscription.
export const CAPTION_LANGUAGES: LanguageOption[] = [
  { value: "ru-RU", label: "Russian" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "it-IT", label: "Italian" },
  { value: "nl-NL", label: "Dutch" },
  { value: "pl-PL", label: "Polish" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "kk-KZ", label: "Kazakh" },
]

/** How many languages may be pinned. Three keeps the top of the list short. */
export const MAX_FAVOURITE_LANGUAGES = 3

/** A divider row between the pinned languages and the rest of the list. */
export const LANGUAGE_SEPARATOR = "──────────"

export type LanguageRow = LanguageOption & { separator?: true }

/**
 * The caption list with the user's pinned languages first.
 *
 * Every language stays in the list — pinning reorders, it never hides, so a
 * meeting in an unexpected language is still one scroll away. Tags that are not
 * in the built-in list are ignored rather than invented, and duplicates collapse.
 *
 * The divider is a row with `separator: true` for the caller to render disabled.
 * It only appears when it separates something from something: no favourites, or
 * everything favourited, and the list is exactly as it was.
 */
export function orderedLanguages(
  all: LanguageOption[],
  favourites: string[] = [],
): LanguageRow[] {
  const known = new Map(all.map((lang) => [lang.value, lang]))
  const pinned: LanguageOption[] = []
  const seen = new Set<string>()
  for (const value of favourites) {
    const lang = known.get(value)
    if (!lang || seen.has(value)) continue
    seen.add(value)
    pinned.push(lang)
    if (pinned.length === MAX_FAVOURITE_LANGUAGES) break
  }
  const rest = all.filter((lang) => !seen.has(lang.value))
  if (pinned.length === 0 || rest.length === 0) return [...pinned, ...rest]
  return [...pinned, { value: LANGUAGE_SEPARATOR, label: LANGUAGE_SEPARATOR, separator: true }, ...rest]
}
