import type { ActiveSession, DebugEvent, Meeting } from "../shared/types"
import { ACTIVE_TABS_KEY, getLocal, getSettings, removeLocal, sessionKey, setLocal, tabIdFromSessionKey } from "../shared/storage"
import { addPendingExport, commitFinalizedMeeting, enqueue } from "./store"
import { MERGE_GAP_MS } from "./merge"

const finalizing = new Set<number>()

export interface FinalizeResult {
  meeting: Meeting | null // null when the session was empty (no transcript/chat) but had debug
  debug: DebugEvent[]
  title: string // for naming the debug file even when meeting is null
  startedAt: string
  isPrivate: boolean // gates the debug-log download — private meetings never get one
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
    const debug = session.debug ?? []
    // A session is "empty" (no Meeting saved) only when nothing was captured AND
    // the recorder dropped no notes/bookmarks — notes alone are worth keeping.
    const empty =
      session.transcript.length === 0 && session.chat.length === 0 && (session.notes?.length ?? 0) === 0
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
    if (empty) {
      // Empty session: do not build/store a Meeting (history stays clean).
      await removeLocal(sessionKey(tabId))
      await untrackTab(tabId)
      return { meeting: null, debug, title: session.title, startedAt: session.startedAt, isPrivate: session.isPrivate }
    }
    const settings = await getSettings()
    const meeting: Meeting = {
      id: crypto.randomUUID(),
      platform: session.platform,
      title: session.title,
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      isPrivate: session.isPrivate,
      transcript: session.transcript,
      chat: session.chat,
      participants: session.participants ?? [],
      rawVersions: session.rawVersions ?? [],
      notes: session.notes ?? [],
      recorder: session.selfName,
      language: session.captionLanguage ?? settings.captionLanguage,
      meetingUrl:
        session.platform === "meet" && session.path ? `https://meet.google.com${session.path}` : undefined,
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
    await removeLocal(sessionKey(tabId))
    // Untrack only after the session key is gone — a failed finalization must
    // keep the tab tracked so the update-deferral guard still sees it.
    await untrackTab(tabId)
    // The .md is `stored` (possibly merged); title/startedAt stay the incoming
    // visit's so the per-visit debug log keeps its own name (logs are not merged).
    return { meeting: stored, debug, title: session.title, startedAt: session.startedAt, isPrivate: session.isPrivate }
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
