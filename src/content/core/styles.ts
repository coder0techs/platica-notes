// The one stylesheet for everything the extension draws inside someone else's
// meeting. It exists because the in-meeting UI used to be styled entirely with
// inline `style.cssText`, and an inline style cannot express `:hover`,
// `:focus-visible` or `prefers-reduced-motion`, so the overlay had no visible
// keyboard focus anywhere, and every hover state was hand-rolled with mouseenter
// listeners that then had to be undone by hand on every state change.
//
// Rules for living in a hostile document:
//   * Every selector is scoped under `.platica-ui-el` (the class registerUiEl
//     already puts on each root element). Nothing here can match Meet's own DOM.
//   * Nothing is inherited from the host. Font, colour, border, background,
//     margin and padding are stated on every element we draw.
//   * The tokens live on `.platica-ui-el` rather than `:root`, for the same
//     reason: we do not write to the host's root.
//   * The palette is deliberately dark and fixed, not `prefers-color-scheme`
//     aware. This is an overlay on a video call: it sits over dark tiles and
//     shared screens in either browser theme, and it has always been dark. The
//     hues are the extension's own (the same record red, violet and speaker
//     colours the pages use), so the overlay and the app read as one product.

const STYLE_ID = "platica-styles"

const CSS = `
.platica-ui-el {
  --pn-surface: rgba(26, 28, 34, .94);
  --pn-surface-hover: rgba(56, 60, 70, .96);
  --pn-menu: rgba(34, 37, 44, .98);
  --pn-line: rgba(255, 255, 255, .14);
  --pn-text: #e8eaf0;
  --pn-text-2: #a3aaba;
  --pn-rec: #ff4d45;
  --pn-rec-off: rgba(95, 99, 104, .95);
  --pn-violet: #c58af9;
  --pn-amber: #fdd663;
  --pn-danger: #ff8a80;
  --pn-blue: #8ab4f8;
  --pn-sans: "Google Sans", Roboto, system-ui, -apple-system, sans-serif;
  --pn-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --pn-r: 10px;
  --pn-r-sm: 6px;
  --pn-pill: 999px;
  --pn-shadow: 0 8px 28px rgba(0, 0, 0, .38);
}
.platica-ui-el, .platica-ui-el *, .platica-ui-el *::before, .platica-ui-el *::after {
  box-sizing: border-box;
}
.platica-ui-el :focus-visible {
  outline: 2px solid var(--pn-blue);
  outline-offset: 2px;
}

/* --- the control bar ------------------------------------------------------- */
.pn-bar {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px; z-index: 2147483647;
}
.pn-pill {
  display: inline-flex; align-items: center; gap: 7px;
  height: 34px; margin: 0; padding: 0 14px;
  border: 1px solid var(--pn-line); border-radius: var(--pn-pill);
  background: var(--pn-surface); color: var(--pn-text);
  font: 500 13px/1 var(--pn-sans); text-align: left;
  cursor: pointer; transition: background .12s ease, border-color .12s ease;
}
.pn-pill:hover { background: var(--pn-surface-hover); }

/* Recording: red fill while live, grey while paused. The clock is the liveness
   signal: a frozen clock says something is wrong before any warning does. */
.pn-rec { border-color: transparent; background: var(--pn-rec); color: #1a1014; font-weight: 600; }
.pn-rec:hover { background: var(--pn-rec); filter: brightness(1.08); }
.pn-rec.is-paused { background: var(--pn-rec-off); color: var(--pn-text); }
.pn-rec.is-paused:hover { background: var(--pn-surface-hover); filter: none; }
.pn-rec-dot {
  width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none;
}
.pn-rec.is-paused .pn-rec-dot { border-radius: 1px; }
.pn-clock {
  font: 500 12px/1 var(--pn-mono); font-variant-numeric: tabular-nums;
  letter-spacing: .01em; opacity: .85;
}
.pn-lock { font-size: 12px; }

/* Pinned-language buttons: the active one is filled, the rest recede. */
.pn-lang { border-color: transparent; opacity: .78; padding: 0 12px; }
.pn-lang:hover { opacity: 1; }
.pn-lang[aria-pressed="true"] {
  opacity: 1; background: rgba(26, 115, 232, .95); color: #fff;
}
.pn-lang[aria-pressed="true"]:hover { background: rgba(26, 115, 232, .95); filter: brightness(1.08); }
.pn-lang-code { font: 500 11px/1 var(--pn-mono); letter-spacing: .04em; }

.pn-more {
  width: 38px; padding: 0; justify-content: center;
  border-color: transparent; font-size: 15px;
}
.pn-more[aria-expanded="true"] { background: var(--pn-surface-hover); }

/* --- the overflow menu ---------------------------------------------------- */
.pn-more-wrap { position: relative; display: flex; }
.pn-menu {
  position: absolute; top: 42px; right: 0; min-width: 286px;
  display: none; flex-direction: column; gap: 2px;
  margin: 0; padding: 6px;
  background: var(--pn-menu); border: 1px solid var(--pn-line);
  border-radius: var(--pn-r); box-shadow: var(--pn-shadow);
}
.pn-menu.is-open { display: flex; }
.pn-row {
  position: relative; display: flex; align-items: center; gap: 9px;
  /* min-height, not height: the armed confirm and a long language name both wrap,
     and a fixed height clipped exactly the text that had to be read. */
  width: 100%; min-height: 36px; margin: 0; padding: 7px 10px;
  border: none; border-radius: var(--pn-r-sm);
  background: transparent; color: var(--pn-text);
  font: 400 13px/1 var(--pn-sans); text-align: left; cursor: pointer;
  transition: background .12s ease;
}
.pn-row:hover { background: rgba(255, 255, 255, .08); }
.pn-row-end { margin-left: auto; color: var(--pn-text-2); font-size: 12px; }
.pn-row-state { margin-left: auto; font: 500 11px/1 var(--pn-mono); color: var(--pn-text-2); }
.pn-row.is-on .pn-row-state { color: var(--pn-violet); }
.pn-row-danger { color: var(--pn-danger); }
.pn-row-danger:hover { background: rgba(255, 138, 128, .14); }
/* The armed confirm used to be red text on an amber fill, which could not be
   read at the one moment it had to be. Dark ink on amber, and it says what the
   next click does. */
.pn-row-danger.is-armed {
  background: var(--pn-amber); color: #241a00; font-weight: 600;
}
.pn-row-danger.is-armed:hover { background: var(--pn-amber); filter: brightness(1.04); }
.pn-menu-foot {
  margin: 4px 2px 2px; padding-top: 7px;
  border-top: 1px solid var(--pn-line);
  color: var(--pn-text-2); font: 400 11.5px/1.5 var(--pn-sans);
}
.pn-key {
  font: 500 10.5px/1.5 var(--pn-mono); color: var(--pn-text);
  background: rgba(255, 255, 255, .1); border: 1px solid var(--pn-line);
  border-radius: 4px; padding: 1px 4px; white-space: nowrap;
}

/* The language row keeps a transparent native <select> stretched across it, so
   the whole row opens the OS dropdown rather than a narrow text zone. */
.pn-row-select {
  position: absolute; inset: 0; width: 100%; height: 100%;
  margin: 0; padding: 0; border: none; opacity: 0; cursor: pointer;
}

/* --- transient messages --------------------------------------------------- */
.pn-pulse {
  position: fixed; top: 0; left: 0; width: 100%; height: 3px;
  z-index: 2147483647; pointer-events: none;
  background-color: transparent; transition: background-color .3s ease-in;
}
.pn-toast, .pn-notice {
  position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; display: flex; align-items: center; gap: 10px;
  max-width: min(460px, calc(100vw - 24px));
  margin: 0; padding: 10px 12px 10px 15px;
  border: 1px solid var(--pn-line); border-radius: var(--pn-r);
  background: var(--pn-menu); color: var(--pn-text);
  font: 400 13.5px/1.4 var(--pn-sans); box-shadow: var(--pn-shadow);
}
/* A notice needs acting on, so it carries the extension's warning colour on a
   rail rather than by shouting in amber all over. */
.pn-notice { border-left: 3px solid var(--pn-amber); }
.pn-msg-text { flex: 1 1 auto; min-width: 0; }
.pn-close {
  flex: none; width: 24px; height: 24px; margin: 0; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: var(--pn-r-sm);
  background: transparent; color: var(--pn-text-2);
  font: 400 14px/1 var(--pn-sans); cursor: pointer;
}
.pn-close:hover { background: rgba(255, 255, 255, .1); color: var(--pn-text); }

/* --- start-of-meeting language prompt ------------------------------------- */
.pn-prompt {
  position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; width: min(380px, calc(100vw - 24px));
  display: flex; flex-direction: column; gap: 10px;
  margin: 0; padding: 15px 16px;
  border: 1px solid var(--pn-line); border-left: 3px solid var(--pn-violet);
  border-radius: var(--pn-r); background: var(--pn-menu); color: var(--pn-text);
  font: 400 13.5px/1.45 var(--pn-sans); box-shadow: var(--pn-shadow);
}
.pn-prompt-title { margin: 0; font: 600 14.5px/1.3 var(--pn-sans); }
.pn-prompt-body { margin: 0; color: var(--pn-text-2); }
.pn-select {
  width: 100%; height: 36px; margin: 0; padding: 0 9px;
  border: 1px solid var(--pn-line); border-radius: var(--pn-r-sm);
  background: rgba(0, 0, 0, .3); color: var(--pn-text);
  font: 400 13.5px/1 var(--pn-sans); cursor: pointer;
}
.pn-btn {
  height: 38px; margin: 0; padding: 0 15px;
  border: 1px solid var(--pn-violet); border-radius: var(--pn-r-sm);
  background: var(--pn-violet); color: #1b1224;
  font: 600 13.5px/1 var(--pn-sans); cursor: pointer;
  transition: filter .12s ease;
}
.pn-btn:hover { filter: brightness(1.06); }
.pn-btn-quiet {
  align-self: flex-start; height: auto; margin: 0; padding: 2px 0;
  border: none; background: none; color: var(--pn-text-2);
  font: 400 12.5px/1.4 var(--pn-sans); text-decoration: underline; cursor: pointer;
}
.pn-btn-quiet:hover { color: var(--pn-text); }

/* --- the live transcript panel -------------------------------------------- */
.pn-panel {
  position: fixed; top: 60px; right: 16px; z-index: 2147483647;
  width: 372px; height: 52vh; min-width: 288px; min-height: 200px;
  resize: both; overflow: hidden;
  display: none; flex-direction: column;
  border: 1px solid var(--pn-line); border-radius: var(--pn-r);
  background: var(--pn-surface); box-shadow: var(--pn-shadow);
}
.pn-panel.is-open { display: flex; }
.pn-panel-head {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 9px 10px 9px 14px; border-bottom: 1px solid var(--pn-line);
  cursor: move; user-select: none;
}
.pn-panel-title {
  flex: 0 0 auto; color: var(--pn-text);
  font: 500 13.5px/1 var(--pn-sans); pointer-events: none;
}
.pn-input {
  margin: 0; padding: 6px 10px; min-width: 0;
  border: 1px solid var(--pn-line); border-radius: var(--pn-r-sm);
  background: rgba(255, 255, 255, .06); color: var(--pn-text);
  font: 400 12.5px/1.3 var(--pn-sans); cursor: text;
}
.pn-input::placeholder { color: var(--pn-text-2); }
.pn-input:hover { border-color: rgba(255, 255, 255, .26); }
.pn-panel-search { flex: 1 1 auto; }
.pn-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px; }
.pn-panel-foot {
  flex: 0 0 auto; display: flex; gap: 7px;
  padding: 8px 14px; border-top: 1px solid var(--pn-line);
}
.pn-note-input { flex: 1 1 auto; }
.pn-note-add {
  flex: none; padding: 6px 12px;
  border: 1px solid var(--pn-line); border-radius: var(--pn-r-sm);
  background: rgba(255, 255, 255, .06); color: var(--pn-text);
  font: 500 14px/1 var(--pn-sans); cursor: pointer;
}
.pn-note-add:hover { background: rgba(255, 255, 255, .12); }
.pn-jump {
  position: absolute; left: 50%; transform: translateX(-50%);
  margin: 0; padding: 5px 13px;
  border: 1px solid var(--pn-line); border-radius: var(--pn-pill);
  background: var(--pn-menu); color: var(--pn-text);
  font: 500 11px/1 var(--pn-sans); cursor: pointer; box-shadow: var(--pn-shadow);
}
.pn-jump:hover { background: var(--pn-surface-hover); }

/* A timeline entry, drawn the way the saved file writes it: a rail in the
   speaker's colour, the speaker and clock, then the body. */
.pn-turn {
  display: grid; grid-template-columns: 3px minmax(0, 1fr); gap: 0 10px;
  margin-bottom: 12px;
}
.pn-turn::before {
  content: ""; border-radius: var(--pn-pill);
  background: var(--pn-turn-color, var(--pn-text-2));
}
.pn-turn.is-right { grid-template-columns: minmax(0, 1fr) 3px; text-align: right; }
.pn-turn.is-right::before { order: 2; }
.pn-turn-head {
  margin: 0 0 3px; color: var(--pn-turn-color, var(--pn-text-2));
  font: 500 12px/1.3 var(--pn-sans);
}
.pn-turn-clock {
  font: 400 11px/1 var(--pn-mono); font-variant-numeric: tabular-nums;
  color: var(--pn-text-2); margin-left: 5px;
}
.pn-turn-text {
  margin: 0; color: var(--pn-text);
  font: 400 13px/1.5 var(--pn-sans);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.pn-turn-text a { color: var(--pn-blue); text-decoration: underline; }
.pn-panel-empty {
  margin: 0; padding: 18px 4px; color: var(--pn-text-2);
  font: 400 12.5px/1.55 var(--pn-sans); text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .platica-ui-el, .platica-ui-el * {
    transition-duration: .001ms !important;
    animation-duration: .001ms !important;
  }
}
`

/**
 * Inject the stylesheet once per document. Called from registerUiEl, so it is
 * impossible to add an extension element without its styles being present.
 */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = CSS
  // documentElement, not head: at document_start the head may not exist yet, and
  // Meet replaces large parts of the body on navigation.
  document.documentElement.appendChild(style)
}
