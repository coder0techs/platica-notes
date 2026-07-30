// Runtime registration of the optional platforms' content scripts.
//
// Only Google Meet is declared in the manifest. Zoom is opt-in: the user enables it in
// the settings page, which asks for the zoom.us host permission, and only then are
// these scripts registered. A default install therefore sees nothing but Meet, and
// the store listing does not have to claim access to a site most users never record.

import { ZOOM_ORIGIN } from "../shared/platforms"

// Only the web client's meeting pages, not the whole of zoom.us: the marketing site,
// the account pages and the billing flow are none of our business.
const ZOOM_MATCHES = ["*://*.zoom.us/wc/*"]

const ZOOM_SCRIPTS: chrome.scripting.RegisteredContentScript[] = [
  {
    id: "zoom-capture",
    matches: ZOOM_MATCHES,
    js: ["capture-zoom.js"],
    runAt: "document_start",
    world: "MAIN",
    // The web client runs part of itself in an iframe; with allFrames that frame gets
    // its own copy of the hook instead of having to be reached from the top document.
    allFrames: true,
    persistAcrossSessions: true,
  },
  {
    id: "zoom-content",
    matches: ZOOM_MATCHES,
    js: ["content-zoom.js"],
    persistAcrossSessions: true,
  },
]

export async function hasZoomPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [ZOOM_ORIGIN] })
}

/**
 * Bring the registered scripts in line with the permission we actually hold. Safe to
 * call repeatedly (on service-worker start, and whenever a permission changes):
 * already-registered ids are removed first so registration never throws on a
 * duplicate.
 */
export async function syncZoomScripts(): Promise<boolean> {
  const wanted = await hasZoomPermission()
  const ids = ZOOM_SCRIPTS.map((s) => s.id)
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids })
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids })
    if (wanted) await chrome.scripting.registerContentScripts(ZOOM_SCRIPTS)
  } catch (error) {
    // A failure here means Zoom simply is not recorded; it must never take the
    // service worker (and with it Meet) down.
    console.error("[platica-notes] zoom script registration failed:", error)
    return false
  }
  return wanted
}
