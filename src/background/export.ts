import { getSettings } from "../shared/storage"
import { DEFAULT_SETTINGS, type DebugEvent, type Meeting } from "../shared/types"
import { debugLogFileName, formatDebugLog, formatMeetingText, liteLogFileName, meetingFileName, monthFolder, sanitizeFolder } from "./format"
import { type ConflictAction, filenameGuard } from "./filename-guard"
import { meetingFolderFor } from "../shared/paths"

// Every download goes through here so the name is registered with the guard before
// Chrome runs its filename-determination round. See filename-guard.ts for why the
// `filename` below cannot be trusted on its own.
async function startDownload(url: string, filename: string, conflictAction: ConflictAction): Promise<number> {
  filenameGuard.expect({ url, filename, conflictAction })
  try {
    return await chrome.downloads.download({ url, filename, conflictAction })
  } catch (error) {
    filenameGuard.forget(url)
    throw error
  }
}

// Where a meeting's .md lands, relative to Downloads. One helper because the
// snapshot has to resolve the same path finalization will, or a mid-meeting save
// leaves a partial file under a name nothing ever completes.
function meetingPath(settings: { folderPublic: string; folderPrivate: string }, meeting: Meeting): string {
  return `${meetingFolderFor(settings, meeting)}/${meetingFileName(meeting)}`
}

const markdownUrl = (content: string): string =>
  // octet-stream so Chrome keeps the ".md" filename (text/plain would be rewritten
  // to ".txt"). Content is unchanged UTF-8 markdown. Same trick as downloadDebugLog.
  "data:application/octet-stream;charset=utf-8," + encodeURIComponent(content)

/**
 * What a session has already written to disk, so the next write lands on the same
 * file instead of beside it.
 *
 * Held by the background against the tab id, not inside the session: the content
 * script rewrites the whole session object roughly once a second, and anything the
 * background stored in it would be gone by the next caption.
 */
export interface SnapshotState {
  /** Path of the .md this session wrote, relative to Downloads. */
  transcript?: string
  /** Path of the debug dump this session wrote, when the log was on. */
  debug?: string
  /** Download rows the last save created, erased once the next save replaces them. */
  rows?: number[]
}

/**
 * Drop download-manager rows for files we have since rewritten.
 *
 * Saving mid-meeting writes the same path over and over, and every write is its
 * own row in Chrome's download list. After an hour of a long call that is a screen
 * of identical entries. The files are untouched; only the list is tidied, and only
 * of rows this extension created.
 */
export async function eraseDownloadRows(ids: number[] | undefined): Promise<void> {
  for (const id of ids ?? []) {
    try {
      await chrome.downloads.erase({ id })
    } catch {
      // A row the user already cleared is not a problem worth surfacing.
    }
  }
}

export async function downloadMeeting(meeting: Meeting, written?: SnapshotState): Promise<void> {
  const settings = await getSettings()
  const content = formatMeetingText(meeting, { alternatives: settings.captionAlternatives })
  const url = markdownUrl(content)
  const path = meetingPath(settings, meeting)
  // Public and private transcripts go to independent, user-configurable folders
  // (no longer necessarily siblings), each split by month inside, because a flat
  // directory is unusable after a week of meetings. All paths are relative to
  // Downloads, the only place chrome.downloads can write. meetingFolder is shared
  // with the popup, which shows the user this exact path while a call runs.
  //
  // A merged meeting (visits > 1) rewrites the same file it produced on the first
  // visit (startedAt + title are preserved, so the name is identical). A
  // single-visit meeting still uniquifies so it never clobbers a sibling.
  //
  // A mid-meeting save has the same claim on the file: once this session has
  // written that exact path, the finished transcript replaces it rather than
  // landing beside it as "… (1).md" and leaving the partial file as the canonical
  // one. Only this session's own path counts, so a stranger's file with the same
  // name is still protected by uniquify.
  await startDownload(
    url,
    path,
    (meeting.visits?.length ?? 0) > 1 || written?.transcript === path ? "overwrite" : "uniquify",
  )
  await eraseDownloadRows(written?.rows)
}

/**
 * Write the transcript as it stands, mid-meeting, for a tool waiting on the file.
 *
 * It goes to the very path the finished meeting will go to, carrying a disclaimer
 * that says so, and the finished transcript later overwrites it. That is the whole
 * contract: one file per meeting, which only ever grows, and which says in its own
 * header whether it is done.
 */
export async function downloadSnapshot(
  meeting: Meeting,
  at: string,
  written?: SnapshotState,
): Promise<{ path: string; row: number }> {
  const settings = await getSettings()
  const url = markdownUrl(formatMeetingText(meeting, { alternatives: settings.captionAlternatives, snapshotAt: at }))
  const path = meetingPath(settings, meeting)
  const row = await startDownload(
    url,
    path,
    // The first save of a brand-new meeting still uniquifies, so it cannot clobber
    // an unrelated file that happens to share the name. Every save after that, and
    // any save that lands on a visit this meeting already merged with, overwrites.
    (meeting.visits?.length ?? 0) > 1 || written?.transcript === path ? "overwrite" : "uniquify",
  )
  return { path, row }
}

/** The debug trail as it stands, mid-meeting. Same overwrite discipline as the .md. */
export async function downloadDebugSnapshot(
  meta: { title: string; startedAt: string; meetingUrl?: string },
  events: DebugEvent[],
  written?: SnapshotState,
): Promise<{ path: string; row: number } | null> {
  if (events.length === 0) return null
  const url = "data:application/octet-stream;charset=utf-8," + encodeURIComponent(formatDebugLog(events))
  const settings = await getSettings()
  const folder = sanitizeFolder(settings.folderDebug, DEFAULT_SETTINGS.folderDebug)
  const path = `${folder}/${monthFolder(meta.startedAt)}/${debugLogFileName(meta)}`
  const row = await startDownload(url, path, written?.debug === path ? "overwrite" : "uniquify")
  return { path, row }
}

/**
 * Write the content-free diagnostic log for one meeting.
 *
 * Unlike the debug log this is not gated on a setting and not withheld from
 * private meetings: it carries no transcript, no chat and no participant names,
 * so there is nothing in it that the privacy flag exists to protect. It is only
 * ever written when the user asks for it from the history page - keeping it is
 * automatic, producing a file from it is not.
 */
export async function downloadLiteLog(meeting: Meeting): Promise<void> {
  const events = meeting.lite ?? []
  if (events.length === 0) return // never write empty files
  const url = "data:application/octet-stream;charset=utf-8," + encodeURIComponent(formatDebugLog(events))
  const settings = await getSettings()
  const folder = sanitizeFolder(settings.folderDebug, DEFAULT_SETTINGS.folderDebug)
  await startDownload(url, `${folder}/${monthFolder(meeting.startedAt)}/${liteLogFileName(meeting)}`, "uniquify")
}

export async function downloadDebugLog(
  meta: { title: string; startedAt: string },
  events: DebugEvent[],
  written?: SnapshotState,
): Promise<void> {
  if (events.length === 0) return // never write empty files
  const content = formatDebugLog(events)
  // application/octet-stream: Chrome rewrites the ".jsonl" filename to a known
  // extension based on the data URL MIME — application/json -> ".json",
  // text/plain -> ".txt". octet-stream has no canonical extension, so Chrome
  // leaves the ".jsonl" filename untouched. Content is unchanged JSONL.
  const url = "data:application/octet-stream;charset=utf-8," + encodeURIComponent(content)
  // A single configurable debug folder for both normal and private meetings,
  // never split by privacy: the debug log embeds the full transcript regardless
  // of the isPrivate flag, so the whole folder is local-only by convention and
  // meant to be kept out of cloud sync entirely. Relative to Downloads only.
  const settings = await getSettings()
  const folder = sanitizeFolder(settings.folderDebug, DEFAULT_SETTINGS.folderDebug)
  const path = `${folder}/${monthFolder(meta.startedAt)}/${debugLogFileName(meta)}`
  await startDownload(url, path, written?.debug === path ? "overwrite" : "uniquify")
}
