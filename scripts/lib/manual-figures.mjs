// Figure names used in docs/manual/USER-MANUAL.md -> the store screenshot each
// one resolves to. Two consumers now read this: scripts/manual.mjs inlines them
// as data URIs for the PDF, and build.mjs copies them into the extension so the
// in-extension user manual has the same figures. One map, so the two cannot
// drift and leave the help page with broken images nobody notices.
export const MANUAL_FIGURES = {
  "panel.png": "01-in-meeting-panel.png",
  "recording.png": "02-recording-controls.png",
  "saved-file.png": "03-saved-file.png",
  "history.png": "04-history.png",
  "settings.png": "05-settings.png",
}
