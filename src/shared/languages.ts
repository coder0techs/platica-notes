export interface LanguageOption {
  value: string
  label: string
  /**
   * Flag emoji for the region half of the tag.
   *
   * A flag is a country, not a language, and equating the two is usually wrong.
   * It works here only because every tag in this list is region-qualified —
   * `es-ES` and `es-MX` are different entries — so each one really does name a
   * place. Do not add a bare `es` and reach for a flag.
   */
  flag: string
  /** Two-letter region, shown next to the flag. */
  code: string
}

// Single source of truth for the caption-language picker, shared by the popup
// and the on-screen Meet controls. Values are BCP 47 tags passed to Meet's
// caption stream subscription.
// The code travels with the flag everywhere it is shown. Windows does not render
// regional-indicator pairs as flags — Chrome there shows the bare letters — so a
// flag alone would degrade into something unreadable on a platform we do ship to.
// "RU" beside the flag costs nothing on macOS and is the whole label on Windows.
export const CAPTION_LANGUAGES: LanguageOption[] = [
  { value: "ru-RU", label: "Russian", flag: "🇷🇺", code: "RU" },
  { value: "en-US", label: "English (US)", flag: "🇺🇸", code: "US" },
  { value: "en-GB", label: "English (UK)", flag: "🇬🇧", code: "GB" },
  { value: "es-ES", label: "Spanish (Spain)", flag: "🇪🇸", code: "ES" },
  { value: "es-MX", label: "Spanish (Mexico)", flag: "🇲🇽", code: "MX" },
  { value: "pt-BR", label: "Portuguese (Brazil)", flag: "🇧🇷", code: "BR" },
  { value: "pt-PT", label: "Portuguese (Portugal)", flag: "🇵🇹", code: "PT" },
  { value: "fr-FR", label: "French", flag: "🇫🇷", code: "FR" },
  { value: "de-DE", label: "German", flag: "🇩🇪", code: "DE" },
  { value: "it-IT", label: "Italian", flag: "🇮🇹", code: "IT" },
  { value: "nl-NL", label: "Dutch", flag: "🇳🇱", code: "NL" },
  { value: "pl-PL", label: "Polish", flag: "🇵🇱", code: "PL" },
  { value: "uk-UA", label: "Ukrainian", flag: "🇺🇦", code: "UA" },
  { value: "kk-KZ", label: "Kazakh", flag: "🇰🇿", code: "KZ" },
]

/** How many languages may be pinned. Three keeps the top of the list short. */
export const MAX_FAVOURITE_LANGUAGES = 3

/** A divider row between the pinned languages and the rest of the list. */
export const LANGUAGE_SEPARATOR = "──────────"

// A row is either a real language or the divider between the pinned block and
// the rest. The divider has no flag because it is not a place.
export type LanguageDivider = { value: string; label: string; separator: true }
export type LanguageRow = LanguageOption | LanguageDivider

/** Narrow a row to the divider, so callers can render it disabled. */
export const isDivider = (row: LanguageRow): row is LanguageDivider =>
  (row as LanguageDivider).separator === true

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
  return [...pinned, { value: LANGUAGE_SEPARATOR, label: LANGUAGE_SEPARATOR, separator: true as const }, ...rest]
}
