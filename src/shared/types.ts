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

export interface ActiveSession {
  platform: PlatformId
  title: string
  startedAt: string
  isPrivate: boolean
  transcript: Utterance[]
  chat: ChatMessage[]
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
  hideCaptionsOverlay: boolean
  privateByDefault: boolean
  retentionLimit: number
}

export const DEFAULT_SETTINGS: Settings = {
  hideCaptionsOverlay: true,
  privateByDefault: false,
  retentionLimit: 30,
}
