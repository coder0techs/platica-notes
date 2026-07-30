// The Zoom adapter. Deliberately a skeleton: transcript, meeting title, roster and
// join/leave only. No chat, no caption-language control, no host-side enabling of
// live transcription. Its job is to prove the platform contract holds for a second
// platform; features come after it has survived real calls.
//
// Two limits worth knowing, neither of which is a bug we can fix here:
//   - Only Zoom's WEB client is reachable. The desktop app is invisible to any
//     browser extension, so a call joined in the app records nothing.
//   - Zoom's live transcription is enabled server-side by the host. With it off, no
//     captions exist to read; capture health reports that instead of saving an empty
//     file (see core/health.ts).

import { sendToBackground } from "../../shared/messages"
import type { BackgroundResponse } from "../../shared/messages"
import { getSettings, saveSettings, withDefaults } from "../../shared/storage"
import type { DebugEvent, Settings } from "../../shared/types"
import { isBookmarkChord, isHideUiChord } from "../core/hotkeys"
import { isUiHidden, setUiHidden, showPersistentNotice } from "../core/ui"
import { runSession } from "../core/session-runner"
import { RTC_EVENT } from "../capture/protocol"
import type { CaptureEvent, HealthEvent } from "../capture/protocol"
import type { PlatformAdapter } from "./adapter"

// --- Zoom web-client contract. Verify on a live meeting before each release. ---
// Meeting pages: /wc/<id>/join, /wc/<id>/start, /wc/join/<id>. Everything else
// (landing, post-meeting) is not a meeting.
const MEETING_PATH = /^\/wc\/(?:join\/)?(\d+)/
// -------------------------------------------------------------------------------

// Cadence for noticing the meeting page went away.
const END_WATCH_INTERVAL_MS = 2000
// Zoom's transcript stops the moment the call does, so there is no trailing revision
// to wait for after the end (unlike Meet, which streams a final revision for ~2s).
const CAPTION_FLUSH_MS = 0
// A roster name first seen within this window of the session's start is part of the
// initial roster, not a mid-meeting arrival.
const JOIN_SETTLE_MS = 10_000

// speakerId -> name, page-level so it survives across meetings in this tab.
const roster = new Map<string, string>()
// Latest title and join state reported by the MAIN-world hook (both live in Zoom's
// store, which only that world can read).
let meetingTitle = ""
let joined = false
let lastChannelHealth: HealthEvent["code"] | null = null
let noteSink: ((text: string) => void) | null = null

let debugEnabled = false
const debugEvents: DebugEvent[] = []
let onDebugEvent: (() => void) | null = null

function dlog(msg: string, extra?: Record<string, unknown>): void {
  if (!debugEnabled) return
  console.log("[platica-notes]", msg, extra ?? "")
  debugEvents.push({ ...(extra ?? {}), t: new Date().toISOString(), ctx: "adapter", msg })
  onDebugEvent?.()
}

let contextInvalidated = false
function onContextInvalidated(): void {
  if (contextInvalidated) return
  contextInvalidated = true
  showPersistentNotice(
    "Plática Notes was updated and can't keep recording in this tab. " +
      "Reload the page (or rejoin the call) to resume recording and save this meeting.",
  )
}

function noteIfInvalidated(response: BackgroundResponse): void {
  if (!response.ok && response.invalidated) onContextInvalidated()
}

void main().catch((error) => console.error("[platica-notes]", error))

async function main(): Promise<void> {
  dlog("zoom adapter loaded", { pathname: location.pathname })
  const tabIdResponse = await sendToBackground<number>({ kind: "getTabId" })
  if (!tabIdResponse.ok) {
    console.error("[platica-notes] could not get tab id:", tabIdResponse.error)
    noteIfInvalidated(tabIdResponse)
    return
  }
  const tabId = tabIdResponse.data

  // Page-level bookkeeping for state that outlives one meeting, registered before any
  // session subscribes so the roster is current when a session resolves names.
  subscribeZoomEvents((event) => {
    if (event.type === "roster" && event.speakerId && event.name) {
      roster.set(event.speakerId, event.name)
      return
    }
    if (event.type === "meeting-title" && typeof event.title === "string" && event.title.trim()) {
      meetingTitle = event.title.trim()
      return
    }
    if (event.type === "joined") {
      joined = true
      return
    }
    if (event.type === "health") lastChannelHealth = event.code
  })

  const settings = await getSettings()
  debugEnabled = settings.debugLog
  setUiHidden(settings.hideUi)
  watchHotkeys()
  watchSettings()

  // The web client soft-navigates between its landing page and a call, so watch this
  // tab for meeting pages forever rather than assuming one meeting per page load.
  for (;;) {
    await waitFor(() => zoomAdapter.isMeetingPage())
    const key = zoomAdapter.meetingKey()
    if (!key) continue
    try {
      await runSession({
        tabId,
        adapter: zoomAdapter,
        roster,
        getSelfName: () => null,
        setSelfName: () => {},
        debug: {
          enabled: () => debugEnabled,
          events: () => debugEvents,
          onEvent: (cb) => {
            onDebugEvent = cb
          },
          log: dlog,
        },
        bindNoteSink: (sink) => {
          noteSink = sink
        },
        onContextInvalidated,
        noteIfInvalidated,
      })
    } finally {
      joined = false
    }
    // Wait for the meeting page to actually go away before re-arming, so the same
    // call is not immediately re-recorded.
    await waitFor(() => !zoomAdapter.isMeetingPage())
  }
}

// ---------- helpers ----------

function subscribeZoomEvents(on: (event: CaptureEvent) => void): () => void {
  const onRtcEvent = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (typeof detail !== "string") return
    let parsed: CaptureEvent
    try {
      parsed = JSON.parse(detail) as CaptureEvent
    } catch {
      return
    }
    on(parsed)
  }
  document.addEventListener(RTC_EVENT, onRtcEvent)
  return () => document.removeEventListener(RTC_EVENT, onRtcEvent)
}

function watchSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      const next = withDefaults(changes.settings.newValue as Partial<Settings> | undefined)
      debugEnabled = next.debugLog
      setUiHidden(next.hideUi)
    }
  })
}

function watchHotkeys(): void {
  document.addEventListener("keydown", (event) => {
    if (event.repeat) return
    const isHide = isHideUiChord(event)
    const isBookmark = isBookmarkChord(event)
    if (!isHide && !isBookmark) return
    const target = event.target as HTMLElement | null
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
    event.preventDefault()
    if (isHide) {
      void saveSettings({ hideUi: !isUiHidden() })
    } else {
      noteSink?.("")
    }
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await delay(300)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const zoomAdapter: PlatformAdapter = {
  id: "zoom",
  capabilities: {
    // In-meeting chat rides Zoom's chat slice, which the skeleton does not read.
    chat: false,
    // Zoom's live transcription is a host/account setting, so we cannot switch it.
    languageSwitch: "none",
    rawVersions: true,
    participantEvents: true,
    // Zoom exposes no media-path signal to us; the end comes from the page going away.
    livenessEnd: false,
  },
  captionRules: {
    // Zoom starts a fresh msgId per sentence, so the interruption split that Meet
    // needs would only fragment turns here.
    interruptionGapMs: null,
    speakerLabel: (speakerId) => `Speaker ${speakerId}`,
    // One own-chat transport (and no chat capture at all yet), so no cross-transport
    // dedup is needed.
    selfChatDedupMs: null,
  },
  timings: { captionFlushMs: CAPTION_FLUSH_MS, joinSettleMs: JOIN_SETTLE_MS },
  isMeetingPage: () => MEETING_PATH.test(location.pathname),
  meetingKey: () => location.pathname.match(MEETING_PATH)?.[1] ?? null,
  // Zoom tells us when the join succeeded (JOIN_MEETING_SUCCESS), so we wait for that
  // rather than guessing from the DOM.
  waitForJoin: async (abort) => {
    while (!joined) {
      if (abort()) return false
      await delay(300)
    }
    return true
  },
  // Skeleton limitation: the end is detected by the meeting page going away (leave,
  // navigation) or the tab closing, which the background finalizes on its own. A
  // leave that keeps the same URL is not detected yet.
  watchEnd: (onEnd) => {
    const key = zoomAdapter.meetingKey()
    const timer = setInterval(() => {
      if (zoomAdapter.meetingKey() !== key) onEnd("left the meeting page")
    }, END_WATCH_INTERVAL_MS)
    return () => clearInterval(timer)
  },
  readTitle: () => meetingTitle,
  meetingUrl: (key) => `https://${location.host}/wc/${key}/join`,
  subscribe: (on) => subscribeZoomEvents(on),
  initialHealth: () => lastChannelHealth,
}
