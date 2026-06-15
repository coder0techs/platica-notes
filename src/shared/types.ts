export type PlatformId = "meet" | "zoom" | "teams"

export interface Utterance {
  speaker: string
  startedAt: string // ISO 8601
  text: string
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
}

export interface Settings {
  /** BCP 47 tag passed to Meet's caption stream subscription (e.g. "ru-RU"). */
  captionLanguage: string
  privateByDefault: boolean
  retentionLimit: number
  debugLog: boolean
}

// captionLanguage is the single source of truth for the default BCP 47 tag.
// main.ts (MAIN-world bundle) imports DEFAULT_SETTINGS directly from here;
// esbuild inlines the const — no runtime browser API is dragged in.
export const DEFAULT_SETTINGS: Settings = {
  captionLanguage: "ru-RU",
  privateByDefault: false,
  retentionLimit: 30,
  debugLog: false,
}
