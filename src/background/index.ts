import type { BackgroundRequest, BackgroundResponse } from "../shared/messages"
import { ACTIVE_TABS_KEY, getLocal, sessionKey, setLocal } from "../shared/storage"
import { isCaptureFailure } from "../shared/types"
import { downloadDebugLog, downloadLiteLog, downloadMeeting } from "./export"
import { installFilenameGuard } from "./filename-guard"
import { shouldOpenWelcome } from "./install"
import {
  mintRelayToken,
  RELAY_TOKENS_KEY,
  verifyRelay,
  withToken,
  withoutToken,
  type RelayTokens,
} from "./relay"
import { finalizeSession, recoverOrphanSessions, trackTab, type FinalizeResult } from "./sessions"
import { clearPendingExport, deleteMeeting, enqueue, getMeeting, listPendingExports } from "./store"

// Before anything can download: the filename-determination round runs before
// chrome.downloads.download() resolves, so this listener has to be registered
// synchronously on every service-worker start.
installFilenameGuard()

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

// The meeting page's own script context, relaying for a content script that an
// update has orphaned. Nothing arriving here is trusted for arriving: verifyRelay
// checks origin, that Chrome's own sender.tab matches the session being claimed,
// and the capability token the trusted content script registered while it lived.
chrome.runtime.onMessageExternal.addListener(
  (message: unknown, sender, sendResponse: (response: BackgroundResponse) => void) => {
    handleExternal(message, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error)
        console.error("[platica-notes] relay failed:", text)
        sendResponse({ ok: false, error: text })
      })
    return true
  },
)

async function handleExternal(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<BackgroundResponse> {
  const tokens = (await getLocal<RelayTokens>(RELAY_TOKENS_KEY)) ?? {}
  const verdict = verifyRelay(message, sender, tokens)
  if (!verdict.accept) return { ok: false, error: verdict.reason }
  await setLocal({ [sessionKey(verdict.tabId)]: verdict.snapshot })
  // A relayed meeting still ends the way any other one does: file written on
  // leave, not left waiting for the tab to close.
  if (verdict.final) await finalizeAndProcess(verdict.tabId)
  return { ok: true, data: null }
}

async function handle(message: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.kind) {
    case "getTabId": {
      const tabId = sender.tab?.id
      if (!tabId) throw new Error("Message has no originating tab")
      return tabId
    }
    case "registerRelayToken": {
      const tabId = sender.tab?.id
      if (!tabId) throw new Error("Message has no originating tab")
      const token = mintRelayToken(crypto.getRandomValues(new Uint8Array(16)))
      await enqueue(async () => {
        const tokens = (await getLocal<RelayTokens>(RELAY_TOKENS_KEY)) ?? {}
        await setLocal({ [RELAY_TOKENS_KEY]: withToken(tokens, tabId, token) })
      })
      return token
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
    case "downloadLiteLog": {
      const meeting = await getMeeting(message.meetingId)
      if (!meeting) throw new Error("Meeting not found")
      if ((meeting.lite ?? []).length === 0) throw new Error("No diagnostics recorded for this meeting")
      await downloadLiteLog(meeting)
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

/**
 * A token is scoped to a TAB, not to a meeting, and it is dropped when the tab
 * goes. Ending a meeting must not drop it: an orphaned content script cannot ask
 * for a new one — asking is what the update broke — so a token that died with the
 * meeting would leave the next call in that tab with no way to save itself. The
 * token buys nothing beyond writing that one tab's session from that one origin,
 * which is exactly as long as the tab is worth anything to an attacker.
 */
async function dropRelayToken(tabId: number): Promise<void> {
  await enqueue(async () => {
    const tokens = (await getLocal<RelayTokens>(RELAY_TOKENS_KEY)) ?? {}
    if (!(String(tabId) in tokens)) return
    await setLocal({ [RELAY_TOKENS_KEY]: withoutToken(tokens, tabId) })
  })
}

// Write the files for a finalized session and clear its pending-export mark only
// after the .md download succeeds. The debug log embeds the full transcript, so a
// meeting marked private never gets one — the privacy flag is honored on every
// export path, not just the .md.
async function deliver(r: FinalizeResult): Promise<void> {
  // A capture failure is kept in history for its diagnostics but has no
  // transcript behind it; writing one would put an empty file in the user's
  // Downloads and imply a recording that never happened.
  if (r.meeting && !isCaptureFailure(r.meeting)) {
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
  void finalizeAndProcess(tabId).finally(() => dropRelayToken(tabId))
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
