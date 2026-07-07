import type { ChatMessage, Note, ParticipantEvent, Utterance } from "../../shared/types"
import { isNearBottom, mergeTimeline } from "../../shared/transcript"
import { registerUiEl } from "./ui"

const RERENDER_THROTTLE_MS = 400

// Stable per-speaker colors, assigned in first-seen order and cycled. Meet-native
// accent hues so names read as distinct without a legend.
const SPEAKER_COLORS = ["#8ab4f8", "#81c995", "#fdd663", "#f28b82", "#c58af9", "#78d9ec"]

const FONT = "'Google Sans',Roboto,system-ui,sans-serif"

// Floating card pinned to the right, in the top half of the screen by default
// (top:60px, half-viewport height). The height is explicit (not content-driven) so
// it does not grow as the transcript fills. The user can resize it from the
// bottom-right corner (resize:both) and drag it by the header (startDrag freezes
// the current size into top/left so it moves freely).
const CARD_CSS =
  "position:fixed;top:60px;right:16px;z-index:2147483647;width:360px;height:50vh;" +
  "min-width:280px;min-height:200px;resize:both;" +
  "display:flex;flex-direction:column;background:rgba(32,33,36,.96);" +
  "border:1px solid rgba(255,255,255,.14);border-radius:12px;" +
  "box-shadow:0 6px 24px rgba(0,0,0,.4);overflow:hidden;"

const HEADER_CSS =
  "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;" +
  "padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1);cursor:move;user-select:none;"

const CLOSE_CSS =
  "background:none;border:none;color:#9aa0a6;font-size:14px;line-height:1;cursor:pointer;padding:2px 6px;"

const BODY_CSS = "flex:1 1 auto;overflow-y:auto;padding:10px 14px;"

const INPUT_CSS =
  "box-sizing:border-box;background:rgba(255,255,255,.06);color:#e8eaed;" +
  "border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 10px;" +
  `font:400 12px ${FONT};outline:none;`

const FOOTER_CSS =
  "flex:0 0 auto;display:flex;gap:6px;padding:8px 14px;border-top:1px solid rgba(255,255,255,.1);"

const JUMP_CSS =
  "position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:#3c4043;" +
  "color:#e8eaed;border:none;border-radius:14px;padding:5px 14px;" +
  `font:500 11px ${FONT};cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);`

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * A floating, draggable transcript card showing the live meeting timeline —
 * speech and chat interleaved chronologically, chat tagged "(chat)". It is
 * shown/hidden by an external toggle (the "Transcript" pill in the top-center
 * meeting controls) via `toggle`/`setVisible`; `onVisibilityChange` lets that pill
 * mirror the open/closed state. Feed `update` the raw per-segment transcript and
 * the chat log; the card merges before rendering. The card has a fixed height and
 * can be dragged by its header out of the way of screen-share.
 */
export function mountTranscriptPanel(opts: {
  onVisibilityChange?: (visible: boolean) => void
  onAddNote?: (text: string) => void
} = {}): {
  update(transcript: Utterance[], chat: ChatMessage[], notes: Note[], participantEvents?: ParticipantEvent[]): void
  toggle(): void
  unmount(): void
} {
  let visible = false
  let latestTranscript: Utterance[] = []
  let latestChat: ChatMessage[] = []
  let latestNotes: Note[] = []
  let latestParticipantEvents: ParticipantEvent[] = []
  let query = ""
  let stickToBottom = true
  let throttleTimer: number | null = null
  let pending = false
  const speakerColor = new Map<string, string>()

  const colorFor = (speaker: string): string => {
    let color = speakerColor.get(speaker)
    if (!color) {
      color = SPEAKER_COLORS[speakerColor.size % SPEAKER_COLORS.length]
      speakerColor.set(speaker, color)
    }
    return color
  }

  const card = document.createElement("div")
  card.style.cssText = CARD_CSS
  card.style.display = "none"
  // Tagged so the global hide toggle can hide it via `visibility`, orthogonal to
  // this panel's own display-based open/closed state (the two never conflict).
  registerUiEl(card)

  const header = document.createElement("div")
  header.style.cssText = HEADER_CSS
  const title = document.createElement("span")
  title.textContent = "Transcript"
  title.style.cssText = `color:#e8eaed;font:500 14px ${FONT};pointer-events:none;flex:0 0 auto;`
  // Live filter over the timeline (speech, chat, and notes). Pure client-side; an
  // empty query shows everything. Typed text is matched as a case-insensitive
  // substring of the speaker label or the entry text.
  const search = document.createElement("input")
  search.type = "search"
  search.placeholder = "Search…"
  search.style.cssText = INPUT_CSS + "flex:1 1 auto;min-width:60px;margin:0 8px;cursor:text;"
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase()
    render()
  })
  // Keep keystrokes out of Meet's global shortcut handler while typing a query
  // (mirrors the note input). No preventDefault, so search/clear still work.
  search.addEventListener("keydown", (event) => event.stopPropagation())
  const close = document.createElement("button")
  close.type = "button"
  close.textContent = "✕"
  close.style.cssText = CLOSE_CSS + "flex:0 0 auto;"
  close.addEventListener("click", () => setVisible(false))
  header.append(title, search, close)

  const body = document.createElement("div")
  body.style.cssText = BODY_CSS
  body.addEventListener("scroll", () => {
    stickToBottom = isNearBottom(body.scrollHeight - body.scrollTop - body.clientHeight)
    updateJumpVisibility()
  })

  const jump = document.createElement("button")
  jump.type = "button"
  jump.textContent = "↓ Jump to latest"
  jump.style.cssText = JUMP_CSS
  jump.style.display = "none"
  jump.addEventListener("click", () => {
    stickToBottom = true
    scrollToBottom()
    updateJumpVisibility()
  })

  // --- note footer: type a note and press Enter (or click +) to drop it onto the
  // timeline at the current moment. The recorder's own annotation, saved with the
  // transcript. ---
  const footer = document.createElement("div")
  footer.style.cssText = FOOTER_CSS
  const noteInput = document.createElement("input")
  noteInput.type = "text"
  noteInput.placeholder = "Add a note…"
  noteInput.style.cssText = INPUT_CSS + "flex:1 1 auto;min-width:0;cursor:text;"
  const addNoteBtn = document.createElement("button")
  addNoteBtn.type = "button"
  addNoteBtn.textContent = "＋"
  addNoteBtn.title = "Add a timestamped note (the moment is captured now)"
  addNoteBtn.style.cssText =
    INPUT_CSS + `flex:0 0 auto;cursor:pointer;font:500 14px ${FONT};padding:6px 12px;`
  const submitNote = () => {
    const text = noteInput.value.trim()
    if (!text) return
    opts.onAddNote?.(text)
    noteInput.value = ""
  }
  noteInput.addEventListener("keydown", (event) => {
    // Keep keystrokes out of Meet's global shortcut handler while typing a note.
    event.stopPropagation()
    if (event.key === "Enter") submitNote()
  })
  addNoteBtn.addEventListener("click", submitNote)
  footer.append(noteInput, addNoteBtn)

  card.append(header, body, jump, footer)
  document.documentElement.append(card)

  // --- dragging: grab the header to move the card. The first drag freezes the
  // current top/bottom/right anchoring into explicit top/left + fixed size, then
  // moves via left/top clamped to the viewport so the header stays reachable. ---
  let dragOffsetX = 0
  let dragOffsetY = 0

  function onDragMove(event: MouseEvent): void {
    const left = clamp(event.clientX - dragOffsetX, 0, window.innerWidth - card.offsetWidth)
    const top = clamp(event.clientY - dragOffsetY, 0, window.innerHeight - card.offsetHeight)
    card.style.left = `${left}px`
    card.style.top = `${top}px`
  }

  function onDragEnd(): void {
    document.removeEventListener("mousemove", onDragMove)
    document.removeEventListener("mouseup", onDragEnd)
  }

  function startDrag(event: MouseEvent): void {
    // The search input lives in the draggable header; let it take focus/clicks.
    if (event.target === close || event.target === search) return
    event.preventDefault()
    const rect = card.getBoundingClientRect()
    // Freeze the auto (top+bottom) height and right anchor into explicit values.
    card.style.height = `${rect.height}px`
    card.style.width = `${rect.width}px`
    card.style.top = `${rect.top}px`
    card.style.left = `${rect.left}px`
    card.style.right = "auto"
    card.style.bottom = "auto"
    dragOffsetX = event.clientX - rect.left
    dragOffsetY = event.clientY - rect.top
    document.addEventListener("mousemove", onDragMove)
    document.addEventListener("mouseup", onDragEnd)
  }

  header.addEventListener("mousedown", startDrag)

  function scrollToBottom(): void {
    body.scrollTop = body.scrollHeight
  }

  function updateJumpVisibility(): void {
    jump.style.display = visible && !stickToBottom ? "block" : "none"
  }

  function setVisible(next: boolean): void {
    if (next === visible) return
    visible = next
    card.style.display = next ? "flex" : "none"
    if (next) {
      stickToBottom = true
      render()
      scrollToBottom()
      updateJumpVisibility()
    }
    opts.onVisibilityChange?.(visible)
  }

  // Notes/bookmarks read as the recorder's own marks: a fixed amber accent (not a
  // per-speaker color) so they stand apart from speech and chat.
  const NOTE_COLOR = "#fdd663"

  function matches(entry: { speaker: string; text: string }): boolean {
    if (!query) return true
    return entry.speaker.toLowerCase().includes(query) || entry.text.toLowerCase().includes(query)
  }

  function render(): void {
    const timeline = mergeTimeline(latestTranscript, latestChat, latestNotes, latestParticipantEvents).filter(matches)
    body.replaceChildren()
    for (const entry of timeline) {
      const block = document.createElement("div")
      const isNote = entry.kind === "note"
      const isPresence = entry.kind === "join" || entry.kind === "leave"
      const isBookmark = isNote && entry.text.trim() === ""
      // Bookmarks and presence markers have no body — just the heading line.
      const noBody = isBookmark || isPresence
      // Voice reads down the left; chat and presence markers align to the right so
      // they are visually distinct from what was spoken aloud. Notes stay left (the
      // recorder's own left-margin marks).
      const alignRight = entry.kind === "chat" || isPresence
      block.style.cssText = `margin-bottom:12px;${alignRight ? "text-align:right;" : ""}`
      const head = document.createElement("div")
      // Presence markers take the participant's own colour (like their speech/chat);
      // notes keep the fixed amber accent.
      const headColor = isNote ? NOTE_COLOR : colorFor(entry.speaker)
      head.style.cssText = `color:${headColor};font:500 12px ${FONT};margin-bottom:2px;`
      // Chat is tagged so a pasted line is never mistaken for something said aloud;
      // notes/bookmarks are the recorder's own marks; join/leave are presence markers.
      const label = isBookmark
        ? "🔖 Bookmark"
        : isNote
          ? "📌 Note"
          : entry.kind === "join"
            ? `👋 ${entry.speaker} joined`
            : entry.kind === "leave"
              ? `🚪 ${entry.speaker} left`
              : entry.kind === "chat"
                ? `${entry.speaker} (chat)`
                : entry.speaker
      head.textContent = `${label} ${formatClock(entry.at)}`
      block.append(head)
      if (!noBody) {
        const text = document.createElement("div")
        text.style.cssText =
          "color:#e8eaed;font:400 13px/1.5 Roboto,system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;"
        text.textContent = entry.text
        block.append(text)
      }
      body.append(block)
    }
    if (stickToBottom) scrollToBottom()
  }

  // Leading-edge render, then a coalesced trailing render at most once per
  // RERENDER_THROTTLE_MS while updates keep arriving. No work while hidden.
  function scheduleRender(): void {
    if (!visible) return
    if (throttleTimer !== null) {
      pending = true
      return
    }
    render()
    throttleTimer = window.setTimeout(() => {
      throttleTimer = null
      if (pending) {
        pending = false
        scheduleRender()
      }
    }, RERENDER_THROTTLE_MS)
  }

  return {
    update(transcript: Utterance[], chat: ChatMessage[], notes: Note[], participantEvents: ParticipantEvent[] = []): void {
      latestTranscript = transcript
      latestChat = chat
      latestNotes = notes
      latestParticipantEvents = participantEvents
      scheduleRender()
    },
    toggle(): void {
      setVisible(!visible)
    },
    unmount(): void {
      if (throttleTimer !== null) window.clearTimeout(throttleTimer)
      onDragEnd()
      card.remove()
    },
  }
}
