import type { ActiveSession, Meeting } from "../shared/types"
import { getLocal, getSettings, removeLocal, sessionKey, setLocal } from "../shared/storage"
import { addMeeting, enqueue } from "./store"

const finalizing = new Set<number>()

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

export async function finalizeSession(tabId: number): Promise<Meeting | null> {
  if (finalizing.has(tabId)) return null
  finalizing.add(tabId)
  try {
    const session = await getLocal<ActiveSession>(sessionKey(tabId))
    if (!session || (session.transcript.length === 0 && session.chat.length === 0)) {
      await removeLocal(sessionKey(tabId))
      await untrackTab(tabId)
      return null
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
    }
    const settings = await getSettings()
    await addMeeting(meeting, settings.retentionLimit)
    await removeLocal(sessionKey(tabId))
    // Untrack only after the session key is gone — a failed finalization must
    // keep the tab tracked so the update-deferral guard still sees it.
    await untrackTab(tabId)
    return meeting
  } finally {
    finalizing.delete(tabId)
  }
}

/** Finalize sessions whose tab no longer exists (browser crash, killed tab). */
export async function recoverOrphanSessions(): Promise<Meeting[]> {
  const all = await chrome.storage.local.get(null)
  const recovered: Meeting[] = []
  for (const key of Object.keys(all)) {
    const match = key.match(/^session_(\d+)$/)
    if (!match) continue
    const tabId = Number(match[1])
    const tabAlive = await chrome.tabs.get(tabId).then(() => true, () => false)
    if (!tabAlive) {
      const meeting = await finalizeSession(tabId)
      if (meeting) recovered.push(meeting)
    }
  }
  return recovered
}
