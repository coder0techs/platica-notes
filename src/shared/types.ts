export type PlatformId = "meet" | "zoom" | "teams"

export interface Utterance {
  speaker: string
  startedAt: string // ISO 8601
  text: string
}

export interface CaptionHistory {
  speaker: string
  startedAt: string // ISO 8601
  /** Every distinct caption version, in arrival order; last is the final text. */
  versions: string[]
}

export interface ChatMessage {
  sender: string
  sentAt: string // ISO 8601
  text: string
}

export interface DebugEvent {
  t: string
  ctx: "rtc" | "adapter" | "bg"
  [key: string]: unknown
}

export interface ActiveSession {
  platform: PlatformId
  /** Meeting page pathname; lets a reloaded tab resume its own session only. */
  path?: string
  title: string
  startedAt: string
  isPrivate: boolean
  transcript: Utterance[]
  chat: ChatMessage[]
  /** Names of everyone seen in the roster during this meeting, plus self. */
  participants: string[]
  /** Per-caption revision history. Rides alongside transcript so reload/orphan recovery keep it. */
  rawVersions?: CaptionHistory[]
  /**
   * Learned deviceId -> display name map and the local user's own name. Persisted
   * so a mid-meeting page reload keeps resolving speaker names: Meet only streams
   * the collections roster and fires GetUser at the initial join, not after a
   * reload, so a resumed session must re-seed these or every speaker falls back to
   * "Speaker N".
   */
  roster?: Record<string, string>
  selfName?: string
  debug?: DebugEvent[]
}

export interface Meeting {
  id: string
  platform: PlatformId
  title: string
  startedAt: string
  endedAt: string
  isPrivate: boolean
  transcript: Utterance[]
  chat: ChatMessage[]
  /** Attendee names (deduped), as seen from the local user's connection. */
  participants: string[]
  /** Per-caption revision history (all distinct versions Google streamed). */
  rawVersions?: CaptionHistory[]
}

export interface Settings {
  /** BCP 47 tag passed to Meet's caption stream subscription (e.g. "ru-RU"). */
  captionLanguage: string
  privateByDefault: boolean
  retentionLimit: number
  debugLog: boolean
  // Download subfolders, relative to the browser Downloads directory.
  folderPublic: string
  folderPrivate: string
  folderDebug: string
}

// captionLanguage is the single source of truth for the default BCP 47 tag.
// main.ts (MAIN-world bundle) imports DEFAULT_SETTINGS directly from here;
// esbuild inlines the const — no runtime browser API is dragged in.
export const DEFAULT_SETTINGS: Settings = {
  captionLanguage: "ru-RU",
  privateByDefault: false,
  retentionLimit: 30,
  debugLog: false,
  folderPublic: "meetings/platica-notes",
  folderPrivate: "meetings/platica-notes-private",
  folderDebug: "meetings/platica-notes-logs",
}
