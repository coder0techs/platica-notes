// Zoom web client Redux actions -> canonical capture events. Pure and stateful only
// in the two places it has to be: the per-utterance revision counter (Zoom ships no
// version field) and the last meeting title.
//
// Every field read here is page-controlled data, so nothing is trusted: shapes are
// checked, text is sanitized, oversized text is refused.

import type { CaptureEvent } from "../protocol"

// Zoom's own cap on a caption string. Anything longer is not a caption; refusing it
// keeps a runaway page from pushing megabytes into chrome.storage.
const MAX_TEXT = 65_535

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/**
 * Clean a caption string, or null if there is nothing usable left.
 * The leading form feed is Zoom's own marker on some caption frames; NUL and U+FFFD
 * would otherwise reach the saved file and the panel.
 */
function sanitize(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_TEXT) return null
  let text = value
  if (text.codePointAt(0) === 12) text = text.slice(1)
  text = text.replace(/\0/g, "").replace(/�/g, "").trim()
  return text.length > 0 ? text : null
}

const asId = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

export class ZoomMapper {
  // `${speakerId}/${utteranceId}` -> revisions seen. Zoom has no version field, so
  // arrival order IS the version. A counter (not Date.now(), which Tactiq uses) is
  // required: two revisions inside one millisecond would collide and the feed would
  // drop the second as stale.
  private revisions = new Map<string, number>()
  private meetingTitle = ""
  private joined = false

  /** Last title Zoom reported for this meeting ("" until it does). */
  get title(): string {
    return this.meetingTitle
  }

  /** Has Zoom reported a successful join? */
  get hasJoined(): boolean {
    return this.joined
  }

  map(action: unknown): CaptureEvent[] {
    if (!isRecord(action) || typeof action.type !== "string") return []
    // Some Zoom actions carry their fields directly; Tactiq's reducer hook reads
    // `action.payload ?? action`, so mirror that tolerance.
    const payload = isRecord(action.payload) ? action.payload : action

    switch (action.type) {
      case "SET_NEW_L_T_MESSAGE":
        return this.fromTranscriptCollection(payload.collection)
      case "UPDATE_MESSAGE":
        return this.fromUpdate(payload)
      case "SET_MEETING_TOPIC": {
        if (typeof payload.meetingTopic === "string" && payload.meetingTopic.trim()) {
          this.meetingTitle = payload.meetingTopic.trim()
        }
        return []
      }
      case "JOIN_MEETING_SUCCESS":
        this.joined = true
        return []
      default:
        return []
    }
  }

  /** The live-transcript collection: one action can carry several speakers' turns. */
  private fromTranscriptCollection(collection: unknown): CaptureEvent[] {
    if (!isRecord(collection)) return []
    const out: CaptureEvent[] = []
    for (const item of Object.values(collection)) {
      if (!isRecord(item)) continue
      const user = isRecord(item.user) ? item.user : null
      const speakerId = asId(user?.zoomID)
      const utteranceId = asId(item.msgId)
      const text = sanitize(item.text)
      if (!speakerId || !utteranceId || !text) continue
      out.push(...this.emit(speakerId, utteranceId, text, user?.displayName))
    }
    return out
  }

  /** A single caption revision, carried by its own action. */
  private fromUpdate(payload: Record<string, unknown>): CaptureEvent[] {
    const speakerId = asId(payload.userId)
    const utteranceId = asId(payload.srcMsgID)
    const text = sanitize(payload.message)
    if (!speakerId || !utteranceId || !text) return []
    return this.emit(speakerId, utteranceId, text, payload.previousDisplayName)
  }

  private emit(speakerId: string, utteranceId: string, text: string, displayName: unknown): CaptureEvent[] {
    const out: CaptureEvent[] = []
    // A caption carries its speaker's name, which is also how the roster is learned:
    // Zoom's attendee list is a separate slice we deliberately do not read yet.
    if (typeof displayName === "string" && displayName.trim()) {
      out.push({ type: "roster", speakerId, name: displayName.trim() })
    }
    const key = `${speakerId}/${utteranceId}`
    const revision = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, revision)
    out.push({ type: "utterance", speakerId, utteranceId, revision, text })
    return out
  }
}
