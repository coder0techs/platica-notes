import type { BackgroundRequest, BackgroundResponse } from "../shared/messages"
import { ACTIVE_TABS_KEY } from "../shared/storage"
import { downloadDebugLog, downloadMeeting } from "./export"
import { shouldOpenWelcome } from "./install"
import { finalizeSession, recoverOrphanSessions, trackTab, type FinalizeResult } from "./sessions"
import { clearPendingExport, deleteMeeting, getMeeting, listPendingExports } from "./store"

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
  const r = await finalizeSession(tabId)
  if (!r) return null
  await deliver(r)
  return r.meeting?.id ?? null
}

// Write the files for a finalized session and clear its pending-export mark only
// after the .md download succeeds. The debug log embeds the full transcript, so a
// meeting marked private never gets one — the privacy flag is honored on every
// export path, not just the .md.
async function deliver(r: FinalizeResult): Promise<void> {
  if (r.meeting) {
    await downloadMeeting(r.meeting)
    await clearPendingExport(r.meeting.id)
  }
  if (r.debug.length > 0 && !r.isPrivate) await downloadDebugLog(r, r.debug)
}

// Re-export any meeting committed to history in a prior service-worker life whose
// .md was never confirmed written (SW evicted between commit and download).
async function recoverPendingExports(): Promise<void> {
  for (const id of await listPendingExports()) {
    const meeting = await getMeeting(id)
    if (meeting) await downloadMeeting(meeting)
    // Clear regardless: a missing meeting means it was deleted from history, so
    // the stale id should go too.
    await clearPendingExport(id)
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void finalizeAndProcess(tabId)
})

// First run only: open the welcome page so the user picks a default caption
// language before their first meeting. Skipped on update/restart so it never
// nags existing users or overwrites a language they already chose.
chrome.runtime.onInstalled.addListener((details) => {
  if (shouldOpenWelcome(details.reason)) {
    void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") })
  }
})

// Postpone extension updates while a meeting is being recorded. Best-effort:
// if meetings are active we simply skip the reload — the pending update
// applies on the next natural service worker restart.
chrome.runtime.onUpdateAvailable.addListener(() => {
  void chrome.storage.local.get(ACTIVE_TABS_KEY).then((result) => {
    const tabs = (result[ACTIVE_TABS_KEY] as number[] | undefined) ?? []
    if (tabs.length === 0) chrome.runtime.reload()
  })
})

// On every service-worker start: rescue meetings orphaned by a crash, then
// re-export anything a prior life committed but never finished writing.
void (async () => {
  for (const result of await recoverOrphanSessions()) await deliver(result)
  await recoverPendingExports()
})()
