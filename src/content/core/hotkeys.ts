// Keyboard chords handled by the in-page content script. Pure predicates so the
// matching is unit-testable without a DOM.

export interface KeyChord {
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  /** KeyboardEvent.code — layout-independent physical key (e.g. "KeyH"). */
  code: string
}

/**
 * Alt+Shift+H toggles all on-screen extension UI (controls, transcript panel,
 * toasts). Ctrl/Meta must be absent so we never shadow a browser/OS chord, and
 * we key off `code` so a non-US layout still triggers on the same physical key.
 */
export function isHideUiChord(e: KeyChord): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyH"
}
