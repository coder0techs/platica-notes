export type PlatformId = "meet" | "zoom" | "teams"

export interface Utterance {
  speaker: string
  startedAt: string // ISO 8601
  /**
   * ISO 8601 time the caption text last grew (reached its length). Marks the end of
   * the spoken segment, ignoring Meet's late no-growth "flush" revisions. Used by the
   * live panel to tell a long phrase from a real pause; optional so simpler callers
   * (and legacy data) fall back to startedAt.
   */
  endedAt?: string
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

export interface Note {
  at: string // ISO 8601
  /** The recorder's note. An empty string is a bare bookmark (a marked moment). */
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
  /** Recorder's bookmarks/notes, timestamped. Rides alongside transcript so reload/recovery keep them. */
  notes?: Note[]
  /**
   * Learned deviceId -> display name map and the local user's own name. Persisted
   * so a mid-meeting page reload keeps resolving speaker names: Meet only streams
   * the collections roster and fires GetUser at the initial join, not after a
   * reload, so a resumed session must re-seed these or every speaker falls back to
   * "Speaker N".
   */
  roster?: Record<string, string>
  selfName?: string
  /** BCP 47 caption language active for this session; tracks mid-meeting changes. */
  captionLanguage?: string
  debug?: DebugEvent[]
}

/** One visit's time span within a merged meeting. Absent on single-visit meetings. */
export interface VisitSpan {
  startedAt: string // ISO 8601
  endedAt: string // ISO 8601
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
  /** Recorder's bookmarks/notes, timestamped. */
  notes?: Note[]
  /** Display name of the local user who recorded this meeting. */
  recorder?: string
  /** BCP 47 caption language the stream was captured with, snapshot at finalize. */
  language?: string
  /** Join link of the recorded meeting, e.g. https://meet.google.com/abc-defg-hij. */
  meetingUrl?: string
  /**
   * Per-visit spans when this meeting was assembled from several rejoins of the
   * same Meet code (see background/merge.ts). Absent (undefined) for a normal
   * single-visit meeting. `visits.length > 1` is the canonical "this is merged"
   * signal — read by the downloader (overwrite vs uniquify) and the history page.
   */
  visits?: VisitSpan[]
}

export interface Settings {
  /**
   * Default BCP 47 caption-language tag (e.g. "en-US"). Every NEW meeting starts
   * in this language. The in-meeting language pill overrides only the current
   * meeting (ephemeral) and never writes back here, so a manual switch does not
   * leak into the next meeting. Popup-controlled.
   */
  captionLanguage: string
  privateByDefault: boolean
  retentionLimit: number
  debugLog: boolean
  /**
   * Emit per-caption ASR alternatives in the saved .md (the `> ↳ _alt:_ …`
   * lines). On by default — Meet drops 20-26% of words from final captions, so
   * keeping the alternatives is the safety net against lost words; turn off for a
   * cleaner file.
   */
  captionAlternatives: boolean
  /**
   * Hide every on-screen extension element (top controls, transcript panel,
   * toasts) for screen-sharing or demos. Purely presentational — capture keeps
   * running while hidden. Toggled from the popup or the Alt+Shift+H in-page chord.
   */
  hideUi: boolean
  /**
   * Fold sequential rejoins of the same meeting (same Meet code, within a short
   * gap) into one .md file instead of one per visit. On by default — an accidental
   * leave/rejoin is the common case and merging is reversible (no content lost).
   * Turn off to keep one file per visit.
   */
  mergeRejoins: boolean
  /**
   * Show a prominent prompt at the start of each meeting to confirm/switch the
   * caption language. Off by default — for users who meet in several languages and
   * forget to switch the in-meeting pill. The prompt never blocks capture.
   */
  askLanguageEachMeeting: boolean
  // Download subfolders, relative to the browser Downloads directory.
  folderPublic: string
  folderPrivate: string
  folderDebug: string
}

// captionLanguage is the single source of truth for the default BCP 47 tag.
// main.ts (MAIN-world bundle) imports DEFAULT_SETTINGS directly from here;
// esbuild inlines the const — no runtime browser API is dragged in.
export const DEFAULT_SETTINGS: Settings = {
  captionLanguage: "en-US",
  privateByDefault: false,
  retentionLimit: 30,
  debugLog: false,
  captionAlternatives: true,
  hideUi: false,
  mergeRejoins: true,
  askLanguageEachMeeting: false,
  folderPublic: "meetings/platica-notes",
  folderPrivate: "meetings/platica-notes-private",
  folderDebug: "meetings/platica-notes-logs",
}
