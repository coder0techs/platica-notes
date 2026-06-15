import { getSettings } from "../shared/storage"
import { DEFAULT_SETTINGS, type DebugEvent, type Meeting } from "../shared/types"
import { debugLogFileName, formatDebugLog, formatMeetingText, meetingFileName, sanitizeFolder } from "./format"

export async function downloadMeeting(meeting: Meeting): Promise<void> {
  const content = formatMeetingText(meeting)
  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(content)
  // Public and private transcripts go to independent, user-configurable folders
  // (no longer necessarily siblings). All paths are relative to Downloads, the
  // only place chrome.downloads can write; sanitizeFolder strips any escape.
  const settings = await getSettings()
  const folder = sanitizeFolder(
    meeting.isPrivate ? settings.folderPrivate : settings.folderPublic,
    meeting.isPrivate ? DEFAULT_SETTINGS.folderPrivate : DEFAULT_SETTINGS.folderPublic,
  )
  await chrome.downloads.download({
    url,
    filename: `${folder}/${meetingFileName(meeting)}`,
    conflictAction: "uniquify",
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
    filename: `${folder}/${debugLogFileName(meta)}`,
    conflictAction: "uniquify",
  })
}
