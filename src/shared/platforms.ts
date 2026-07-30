// Optional platforms: the host permissions a default install does NOT hold, shared by
// the settings page (which asks for them) and the background worker (which registers
// the matching content scripts once they are granted).

export const ZOOM_ORIGIN = "*://*.zoom.us/*"

/** Ready-made argument for chrome.permissions.request / .remove / .contains. */
export const ZOOM_PERMISSION = { origins: [ZOOM_ORIGIN] }
