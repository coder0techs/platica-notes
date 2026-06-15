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
