import type { ActiveSession, DebugEvent, Meeting } from "../shared/types"
import { getLocal, getSettings, removeLocal, sessionKey, setLocal } from "../shared/storage"
import { addMeeting, enqueue } from "./store"

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
    const tabs = (await getLocal<number[]>("activeSessionTabs")) ?? []
    if (!tabs.includes(tabId)) {
      await setLocal({ activeSessionTabs: [...tabs, tabId] })
    }
  })
}

function untrackTab(tabId: number): Promise<void> {
  return enqueue(async () => {
    const tabs = (await getLocal<number[]>("activeSessionTabs")) ?? []
    await setLocal({ activeSessionTabs: tabs.filter(id => id !== tabId) })
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
    const empty = session.transcript.length === 0 && session.chat.length === 0
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
    }
    const settings = await getSettings()
    await addMeeting(meeting, settings.retentionLimit)
    await removeLocal(sessionKey(tabId))
    // Untrack only after the session key is gone — a failed finalization must
    // keep the tab tracked so the update-deferral guard still sees it.
    await untrackTab(tabId)
    return { meeting, debug, title: session.title, startedAt: session.startedAt, isPrivate: session.isPrivate }
  } finally {
    finalizing.delete(tabId)
  }
}

/** Finalize sessions whose tab no longer exists (browser crash, killed tab). */
export async function recoverOrphanSessions(): Promise<FinalizeResult[]> {
  const all = await chrome.storage.local.get(null)
  const recovered: FinalizeResult[] = []
  for (const key of Object.keys(all)) {
    const match = key.match(/^session_(\d+)$/)
    if (!match) continue
    const tabId = Number(match[1])
    const tabAlive = await chrome.tabs.get(tabId).then(() => true, () => false)
    if (!tabAlive) {
      const result = await finalizeSession(tabId)
      if (result) recovered.push(result)
    }
  }
  return recovered
}
