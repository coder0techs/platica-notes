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
  localOnly: boolean
  transcript: Utterance[]
  chat: ChatMessage[]
}

export type DriveStatus = "none" | "uploaded" | "failed"

export interface Meeting {
  id: string
  platform: PlatformId
  title: string
  startedAt: string
  endedAt: string
  localOnly: boolean
  transcript: Utterance[]
  chat: ChatMessage[]
  driveStatus: DriveStatus
  driveFileUrl?: string
}

export interface Settings {
  hideCaptionsOverlay: boolean
  uploadToDriveByDefault: boolean
  retentionLimit: number
}

export const DEFAULT_SETTINGS: Settings = {
  hideCaptionsOverlay: true,
  uploadToDriveByDefault: false,
  retentionLimit: 30,
}
