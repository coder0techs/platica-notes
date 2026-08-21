// Download-path helpers. They live in shared/ rather than background/ because the
// pages show the user the path a file will take: the popup states where the
// current meeting is heading and the settings page previews a folder as it is
// typed. Both must agree with what the downloader actually does, character for
// character, so there is exactly one implementation.

import { DEFAULT_SETTINGS, type Settings } from "./types"

const MAX_NAME_LEN = 120

const pad2 = (n: number): string => String(n).padStart(2, "0")

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/[.\s]+$/, "") // re-trim: the slice may have ended on a dot/space
  return cleaned || "Meeting"
}

// Produces a safe RELATIVE path for chrome.downloads: each "/"-segment is run
// through sanitizeFileName, and segments that are empty, "." or ".." are
// dropped. This guarantees no leading "/" (no absolute path), no ".." (no
// escaping Downloads), and no illegal filename chars per segment. Falls back
// when nothing survives.
export function sanitizeFolder(path: string, fallback: string): string {
  const segments = path
    .split("/")
    .filter(seg => {
      const trimmed = seg.trim()
      return trimmed !== "" && trimmed !== "." && trimmed !== ".."
    })
    .map(sanitizeFileName)
  return segments.length > 0 ? segments.join("/") : fallback
}

// The YYYY-MM bucket a meeting is filed under. Derived from the START instant, so
// a call running over midnight into a new month stays with the day it began.
// Digits and one dash only, never user input, so it needs no sanitising.
export function monthFolder(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

/**
 * The folder a meeting's .md lands in, relative to the Downloads directory:
 * the configured public or private folder, then its YYYY-MM bucket.
 *
 * The downloader builds the filename on top of this; the popup and the settings
 * page show it to the user. One function so the three can never disagree: a
 * popup promising a path the downloader does not use would be worse than the
 * popup saying nothing, which is what it used to do.
 */
export function meetingFolder(opts: {
  isPrivate: boolean
  startedAt: string
  folderPublic: string
  folderPrivate: string
}): string {
  const folder = opts.isPrivate
    ? sanitizeFolder(opts.folderPrivate, DEFAULT_SETTINGS.folderPrivate)
    : sanitizeFolder(opts.folderPublic, DEFAULT_SETTINGS.folderPublic)
  return `${folder}/${monthFolder(opts.startedAt)}`
}

/** Convenience over {@link meetingFolder} for a whole Settings object. */
export const meetingFolderFor = (
  settings: Pick<Settings, "folderPublic" | "folderPrivate">,
  meeting: { isPrivate: boolean; startedAt: string },
): string => meetingFolder({ ...settings, ...meeting })
