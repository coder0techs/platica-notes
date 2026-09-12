import type { ActiveSession, DebugEvent, Meeting } from "../shared/types"
import { isCaptureFailure } from "../shared/types"
import { ACTIVE_TABS_KEY, getLocal, getSettings, removeLocal, sessionKey, setLocal, snapshotKey, tabIdFromSessionKey } from "../shared/storage"
import { addMeeting, addPendingExport, commitFinalizedMeeting, enqueue } from "./store"
import { MERGE_GAP_MS } from "./merge"
import type { SnapshotState } from "./export"
import { meetingUrlOf, sessionToMeeting } from "./snapshot"

const finalizing = new Set<number>()

export interface FinalizeResult {
  meeting: Meeting | null // null when the session was empty (no transcript/chat) but had debug
  debug: DebugEvent[]
  title: string // for naming the debug file even when meeting is null
  startedAt: string
  // Same role as `title`: the debug file's name carries the Meet code so it pairs
  // up with its .md, and it is needed even when `meeting` is null.
  meetingUrl?: string
  isPrivate: boolean // gates the debug-log download — private meetings never get one
  /**
   * What a mid-meeting save already wrote for this session, so the final write
   * replaces those files instead of landing beside them.
   */
  written?: SnapshotState
}

export function trackTab(tabId: number): Promise<void> {
  return enqueue(async () => {
    const tabs = (await getLocal<number[]>(ACTIVE_TABS_KEY)) ?? []
    if (!tabs.includes(tabId)) {
      await setLocal({ [ACTIVE_TABS_KEY]: [...tabs, tabId] })
    }
  })
}

function untrackTab(tabId: number): Promise<void> {
  return enqueue(async () => {
    const tabs = (await getLocal<number[]>(ACTIVE_TABS_KEY)) ?? []
    await setLocal({ [ACTIVE_TABS_KEY]: tabs.filter(id => id !== tabId) })
  })
}

export async function finalizeSession(tabId: number): Promise<FinalizeResult | null> {
  if (finalizing.has(tabId)) return null
  finalizing.add(tabId)
  try {
    const session = await getLocal<ActiveSession>(sessionKey(tabId))
    if (!session) {
      // No backing session, but a stale activeSessionTabs entry may still linger
      // (it would otherwise keep the update-deferral guard from ever reloading).
      await untrackTab(tabId)
      return null
    }
    const written = await getLocal<SnapshotState>(snapshotKey(tabId))
    const debug = session.debug ?? []
    // A session is "empty" (no Meeting saved) only when nothing was captured AND
    // the recorder dropped no notes/bookmarks — notes alone are worth keeping.
    const empty = isCaptureFailure(session)
    // Append a bg summary only when debug is non-empty — debug is non-empty
    // exactly when the feature was on, so an empty debug means no file downstream.
    if (debug.length > 0) {
      debug.push({
        t: new Date().toISOString(),
        ctx: "bg",
        msg: empty ? "finalized empty" : "finalized",
        utterances: session.transcript.length,
        chat: session.chat.length,
        isPrivate: session.isPrivate,
      })
    }
    const meetingUrl = meetingUrlOf(session)
    const settings = await getSettings()
    // A meeting that captured NOTHING while other people were in it is a capture
    // failure, not a stray tab, and it used to vanish without trace: no Meeting,
    // no history row, nothing to attach diagnostics to. That is precisely the
    // meeting whose diagnostics someone needs afterwards, which is how a caption
    // channel rename cost a user days with no artefact to show for any of it. So
    // the row is kept, with its lite log, and the participant count is what tells
    // a broken meeting from an empty room nobody ever spoke in.
    const failed = empty && session.participants.length >= 2
    if (empty && !failed) {
      // Nothing captured and nobody else there: nothing happened. History stays clean.
      await removeLocal([sessionKey(tabId), snapshotKey(tabId)])
      await untrackTab(tabId)
      return { meeting: null, debug, title: session.title, startedAt: session.startedAt, meetingUrl, isPrivate: session.isPrivate, written }
    }
    // Built through the same helper the mid-meeting snapshot uses, so the file a
    // reader already has on disk does not change shape when the meeting ends.
    const meeting: Meeting = sessionToMeeting(session, {
      id: crypto.randomUUID(),
      endedAt: new Date().toISOString(),
      fallbackLanguage: settings.captionLanguage,
    })
    // A failed meeting is appended, never merged and never marked for export:
    // folding it into a visit that worked would hide the very failure the row
    // exists to show, and there is no transcript to write a file from.
    if (failed) {
      await addMeeting(meeting, settings.retentionLimit)
      await removeLocal([sessionKey(tabId), snapshotKey(tabId)])
      await untrackTab(tabId)
      return { meeting, debug, title: session.title, startedAt: session.startedAt, meetingUrl, isPrivate: session.isPrivate, written }
    }
    // Commit to history — folding into a prior visit of the same meeting when the
    // user opted in (mergeRejoins). `stored` carries the merge target's identity
    // when merged, so the .md overwrites in place; otherwise it is this meeting.
    const { meeting: stored } = await commitFinalizedMeeting(
      meeting,
      { mergeEnabled: settings.mergeRejoins, gapMs: MERGE_GAP_MS },
      settings.retentionLimit,
    )
    // Mark it for export BEFORE removing the session key / returning, so a crash
    // before the caller's download still leaves a trail for SW-start recovery.
    await addPendingExport(stored.id)
    await removeLocal([sessionKey(tabId), snapshotKey(tabId)])
    // Untrack only after the session key is gone — a failed finalization must
    // keep the tab tracked so the update-deferral guard still sees it.
    await untrackTab(tabId)
    // The .md is `stored` (possibly merged); title/startedAt stay the incoming
    // visit's so the per-visit debug log keeps its own name (logs are not merged).
    return { meeting: stored, debug, title: session.title, startedAt: session.startedAt, meetingUrl, isPrivate: session.isPrivate, written }
  } finally {
    finalizing.delete(tabId)
  }
}

/** Finalize sessions whose tab no longer exists (browser crash, killed tab). */
export async function recoverOrphanSessions(): Promise<FinalizeResult[]> {
  const all = await chrome.storage.local.get(null)
  const recovered: FinalizeResult[] = []
  for (const key of Object.keys(all)) {
    const tabId = tabIdFromSessionKey(key)
    if (tabId === null) continue
    // Only finalize when the tab is *confirmably* gone. chrome.tabs.get rejects
    // with "No tab with id" for a closed tab — but a transient rejection during
    // SW teardown must NOT be read as "dead", or we would finalize a meeting that
    // is still running (the session key gets recreated by the live content
    // script → a split/duplicate meeting, the phantom class fought before).
    const tabGone = await chrome.tabs.get(tabId).then(
      () => false,
      (err: unknown) => /no tab with id/i.test(err instanceof Error ? err.message : String(err)),
    )
    if (tabGone) {
      const result = await finalizeSession(tabId)
      if (result) recovered.push(result)
    }
  }
  return recovered
}
