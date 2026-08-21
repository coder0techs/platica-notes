import { getSettings } from "../shared/storage"
import { DEFAULT_SETTINGS, type DebugEvent, type Meeting } from "../shared/types"
import { debugLogFileName, formatDebugLog, formatMeetingText, meetingFileName, monthFolder, sanitizeFolder } from "./format"
import { meetingFolderFor } from "../shared/paths"

export async function downloadMeeting(meeting: Meeting): Promise<void> {
  const settings = await getSettings()
  const content = formatMeetingText(meeting, { alternatives: settings.captionAlternatives })
  // octet-stream so Chrome keeps the ".md" filename (text/plain would be rewritten
  // to ".txt"). Content is unchanged UTF-8 markdown. Same trick as downloadDebugLog.
  const url = "data:application/octet-stream;charset=utf-8," + encodeURIComponent(content)
  // Public and private transcripts go to independent, user-configurable folders
  // (no longer necessarily siblings), each split by month inside, because a flat
  // directory is unusable after a week of meetings. All paths are relative to
  // Downloads, the only place chrome.downloads can write. meetingFolder is shared
  // with the popup, which shows the user this exact path while a call runs.
  await chrome.downloads.download({
    url,
    filename: `${meetingFolderFor(settings, meeting)}/${meetingFileName(meeting)}`,
    // A merged meeting (visits > 1) rewrites the same file it produced on the
    // first visit (startedAt + title are preserved, so the name is identical).
    // A single-visit meeting still uniquifies so it never clobbers a sibling.
    conflictAction: (meeting.visits?.length ?? 0) > 1 ? "overwrite" : "uniquify",
  })
}

export async function downloadDebugLog(
  meta: { title: string; startedAt: string },
  events: DebugEvent[],
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
  await chrome.downloads.download({
    url,
    filename: `${folder}/${monthFolder(meta.startedAt)}/${debugLogFileName(meta)}`,
    conflictAction: "uniquify",
  })
}
