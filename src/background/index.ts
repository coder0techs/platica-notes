import type { BackgroundRequest, BackgroundResponse } from "../shared/messages"
import { downloadMeeting } from "./export"
import { finalizeSession, recoverOrphanSessions, trackTab } from "./sessions"
import { deleteMeeting, getMeeting } from "./store"

chrome.runtime.onMessage.addListener(
  (message: BackgroundRequest, sender, sendResponse: (response: BackgroundResponse) => void) => {
    handle(message, sender)
      .then(data => sendResponse({ ok: true, data }))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error)
        console.error("[platica-notes]", message.kind, "failed:", text)
        sendResponse({ ok: false, error: text })
      })
    return true
  },
)

async function handle(message: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.kind) {
    case "getTabId": {
      const tabId = sender.tab?.id
      if (!tabId) throw new Error("Message has no originating tab")
      return tabId
    }
    case "meetingStarted": {
      const tabId = sender.tab?.id
      if (tabId) await trackTab(tabId)
      return null
    }
    case "meetingEnded": {
      const tabId = sender.tab?.id
      if (!tabId) throw new Error("Message has no originating tab")
      return finalizeAndProcess(tabId)
    }
    case "downloadMeeting": {
      const meeting = await getMeeting(message.meetingId)
      if (!meeting) throw new Error("Meeting not found")
      await downloadMeeting(meeting)
      return null
    }
    case "deleteMeeting": {
      await deleteMeeting(message.meetingId)
      return null
    }
    default:
      throw new Error(`Unhandled message: ${(message as BackgroundRequest).kind}`)
  }
}

async function finalizeAndProcess(tabId: number): Promise<string | null> {
  const meeting = await finalizeSession(tabId)
  if (!meeting) return null
  await downloadMeeting(meeting)
  return meeting.id
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void finalizeAndProcess(tabId)
})

// Postpone extension updates while a meeting is being recorded.
chrome.runtime.onUpdateAvailable.addListener(() => {
  void chrome.storage.local.get("activeSessionTabs").then((result) => {
    const tabs = (result.activeSessionTabs as number[] | undefined) ?? []
    if (tabs.length === 0) chrome.runtime.reload()
  })
})

// On every service-worker start, rescue meetings orphaned by a crash.
void recoverOrphanSessions().then(async (recovered) => {
  for (const meeting of recovered) {
    await downloadMeeting(meeting)
  }
})
