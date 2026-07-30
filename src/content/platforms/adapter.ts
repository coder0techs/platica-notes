// The contract between the platform-neutral session runner (core/session-runner.ts)
// and one meeting platform. One implementation per platform; the runner holds no
// platform knowledge at all, and everything fragile about a platform (its DOM, its
// wire format, its internal APIs) stays behind this interface.

import type { ActiveSession, PlatformId } from "../../shared/types"
import type { CaptureEvent, HealthEvent } from "../capture/protocol"
import type { CaptionRules } from "../core/feed"

/**
 * What a platform can and cannot do. Declared rather than discovered, so the UI can
 * hide a control instead of offering one that silently does nothing, and so a saved
 * file never implies a feature was active on a platform that cannot supply it.
 */
export interface Capabilities {
  /** In-meeting chat is captured. */
  chat: boolean
  /**
   * Caption-language control.
   *   "self"      — we switch it ourselves (Meet subscribes its own captions channel).
   *   "host-only" — the platform gates it behind the host/organiser role, so a switch
   *                 can fail for reasons outside our control; the pill mounts but has
   *                 to be able to report why.
   *   "none"      — no control at all; the language pill does not mount.
   */
  languageSwitch: "self" | "host-only" | "none"
  /** Per-utterance revision history is available (the ASR-alternatives feature). */
  rawVersions: boolean
  /** Join/leave markers can be derived from the platform's roster. */
  participantEvents: boolean
  /** The end of a call is confirmed by a liveness signal, not only by the DOM. */
  livenessEnd: boolean
}

/** Platform-observed timings the runner needs. Both are measured, not guessed. */
export interface AdapterTimings {
  /**
   * How long to keep receiving after the call ends before finalizing. Meet streams
   * the final caption revision for a couple of seconds after Leave, so cutting the
   * feed at once truncates the closing sentence. 0 for a platform that stops dead.
   */
  captionFlushMs: number
  /**
   * A roster arrival within this window of a session's start is the initial roster
   * (or a post-reload re-sync), not someone joining mid-meeting, so it gets no
   * marker.
   */
  joinSettleMs: number
}

export interface PlatformAdapter {
  readonly id: PlatformId
  readonly capabilities: Capabilities
  readonly captionRules: CaptionRules
  readonly timings: AdapterTimings

  /** Is the current URL a meeting page of this platform? */
  isMeetingPage(): boolean
  /**
   * Stable key identifying THIS meeting within the platform (Meet: the pathname,
   * Zoom: the meeting id). Drives reload-resume matching and rejoin pacing. Null
   * when the page is not a meeting.
   */
  meetingKey(): string | null
  /**
   * Resolve once the user is actually in the call. `abort` is polled; resolve false
   * when it fires (the user backed out of the lobby) so no session is started.
   */
  waitForJoin(abort: () => boolean): Promise<boolean>
  /** Start watching for the end of the call. Returns a teardown function. */
  watchEnd(onEnd: (reason: string) => void): () => void
  /** Human-readable meeting title, or "" to let the runner fall back to document.title. */
  readTitle(): string
  /** Join link for the saved file's front matter, or undefined if none can be built. */
  meetingUrl(key: string): string | undefined
  /** Subscribe to this platform's canonical capture events. Returns an unsubscribe. */
  subscribe(on: (event: CaptureEvent) => void): () => void

  /** Switch the caption language. Absent when capabilities.languageSwitch is "none". */
  setLanguage?(tag: string): void
  /**
   * Capture-path state already observed before this session started, if any. The
   * capture script can open its channel before the runner exists (both happen at
   * join), and without this the runner would sit in "opening" and raise a false
   * "never started" alarm. Return null when nothing is known yet.
   */
  initialHealth?(): HealthEvent["code"] | null
  /**
   * Extra platform-owned fields to stamp into every persisted snapshot (Meet: the
   * chat.google.com conversation URL). Called on every write, so it must be cheap
   * and free of side effects.
   */
  snapshotFields?(): Partial<ActiveSession>
  /** Platform bookkeeping after a meeting is finalized (Meet: arm the tail grace). */
  afterFinalize?(key: string): void
}
