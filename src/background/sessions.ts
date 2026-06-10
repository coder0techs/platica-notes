import type { ActiveSession, Meeting } from "../shared/types"
import { getLocal, getSettings, removeLocal, sessionKey, setLocal } from "../shared/storage"
import { addMeeting } from "./store"

const finalizing = new Set<number>()

export async function trackTab(tabId: number): Promise<void> {
  const tabs = (await getLocal<number[]>("activeSessionTabs")) ?? []
  if (!tabs.includes(tabId)) {
    await setLocal({ activeSessionTabs: [...tabs, tabId] })
  }
}

async function untrackTab(tabId: number): Promise<void> {
  const tabs = (await getLocal<number[]>("activeSessionTabs")) ?? []
  await setLocal({ activeSessionTabs: tabs.filter(id => id !== tabId) })
}

export async function finalizeSession(tabId: number): Promise<Meeting | null> {
  if (finalizing.has(tabId)) return null
  finalizing.add(tabId)
  try {
    const session = await getLocal<ActiveSession>(sessionKey(tabId))
    if (!session || (session.transcript.length === 0 && session.chat.length === 0)) {
      await removeLocal(sessionKey(tabId))
      return null
    }
    const meeting: Meeting = {
      id: crypto.randomUUID(),
      platform: session.platform,
      title: session.title,
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      localOnly: session.localOnly,
      transcript: session.transcript,
      chat: session.chat,
      driveStatus: "none",
    }
    const settings = await getSettings()
    await addMeeting(meeting, settings.retentionLimit)
    await removeLocal(sessionKey(tabId))
    return meeting
  } finally {
    finalizing.delete(tabId)
    await untrackTab(tabId)
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
