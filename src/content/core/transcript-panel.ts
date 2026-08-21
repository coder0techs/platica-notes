import type { ChatMessage, Note, ParticipantEvent, Utterance } from "../../shared/types"
import { linkify } from "./linkify"
import { isNearBottom, mergeTimeline } from "../../shared/transcript"
import { registerUiEl } from "./ui"

const RERENDER_THROTTLE_MS = 400

// Stable per-speaker colors, assigned in first-seen order and cycled. These six
// hues are the extension's palette everywhere: ui.css takes them verbatim for its
// dark theme, so a speaker's colour here and a section's rail on the settings
// page are literally the same value.
const SPEAKER_COLORS = ["#8ab4f8", "#81c995", "#fdd663", "#f28b82", "#c58af9", "#78d9ec"]

// The recorder's own marks read as their own thing: a fixed amber accent, not a
// per-speaker colour, so they stand apart from speech and chat.
const NOTE_COLOR = "#fdd663"

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * A floating, draggable transcript card showing the live meeting timeline —
 * speech and chat interleaved chronologically, chat tagged "(chat)". It is
 * shown/hidden by an external toggle (the "Transcript" row in the meeting
 * controls' overflow menu) via `toggle`/`setVisible`; `onVisibilityChange` lets
 * that row mirror the open/closed state. Feed `update` the raw per-segment
 * transcript and the chat log; the card merges before rendering. The card has a
 * fixed height and can be dragged by its header out of the way of screen-share.
 *
 * Presentation lives in core/styles.ts. Each entry is drawn the way the saved
 * file writes it: a rail in the speaker's colour, the speaker and a monospace
 * clock, then the body. It is the same shape every page of the extension uses
 * for a group of anything.
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
  card.className = "pn-panel"
  // Tagged so the global hide toggle can hide it via `visibility`, orthogonal to
  // this panel's own class-based open/closed state (the two never conflict).
  registerUiEl(card)

  const header = document.createElement("div")
  header.className = "pn-panel-head"
  const title = document.createElement("span")
  title.className = "pn-panel-title"
  title.textContent = "Transcript"
  // Live filter over the timeline (speech, chat, and notes). Pure client-side; an
  // empty query shows everything. Typed text is matched as a case-insensitive
  // substring of the speaker label or the entry text.
  const search = document.createElement("input")
  search.type = "search"
  search.className = "pn-input pn-panel-search"
  search.placeholder = "Search…"
  search.setAttribute("aria-label", "Filter this meeting's timeline")
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase()
    render()
  })
  // Keep keystrokes out of Meet's global shortcut handler while typing a query
  // (mirrors the note input). No preventDefault, so search/clear still work.
  search.addEventListener("keydown", (event) => event.stopPropagation())

  const close = document.createElement("button")
  close.type = "button"
  close.className = "pn-close"
  close.textContent = "✕"
  close.setAttribute("aria-label", "Close the transcript panel")
  close.title = "Close the panel (capture keeps running)"
  close.addEventListener("click", () => setVisible(false))
  header.append(title, search, close)

  const body = document.createElement("div")
  body.className = "pn-panel-body"
  body.addEventListener("scroll", () => {
    stickToBottom = isNearBottom(body.scrollHeight - body.scrollTop - body.clientHeight)
    updateJumpVisibility()
  })

  const jump = document.createElement("button")
  jump.type = "button"
  jump.className = "pn-jump"
  jump.textContent = "↓ Jump to latest"
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
  footer.className = "pn-panel-foot"
  const noteInput = document.createElement("input")
  noteInput.type = "text"
  noteInput.className = "pn-input pn-note-input"
  noteInput.placeholder = "Add a note…"
  noteInput.setAttribute("aria-label", "Add a timestamped note")
  const addNoteBtn = document.createElement("button")
  addNoteBtn.type = "button"
  addNoteBtn.className = "pn-note-add"
  addNoteBtn.textContent = "＋"
  addNoteBtn.title = "Add a timestamped note (the moment is captured now)"
  addNoteBtn.setAttribute("aria-label", "Add a timestamped note")
  const submitNote = (): void => {
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
    card.classList.toggle("is-open", next)
    if (next) {
      // Sit the jump pill just ABOVE the note footer so it never covers the input.
      // Measured now that the card is displayed (offsetHeight is 0 while hidden).
      jump.style.bottom = `${footer.offsetHeight + 10}px`
      stickToBottom = true
      render()
      scrollToBottom()
      updateJumpVisibility()
    }
    opts.onVisibilityChange?.(visible)
  }

  function matches(entry: { speaker: string; text: string }): boolean {
    if (!query) return true
    return entry.speaker.toLowerCase().includes(query) || entry.text.toLowerCase().includes(query)
  }

  // Body text with its links clickable. Every piece still reaches the DOM as a
  // text node or as an anchor's textContent — never as markup — so the
  // no-innerHTML invariant holds by construction rather than by review.
  function appendLinkified(host: HTMLElement, value: string): void {
    for (const segment of linkify(value)) {
      if (segment.kind === "text") {
        host.append(document.createTextNode(segment.value))
        continue
      }
      const anchor = document.createElement("a")
      // linkify only yields http(s) hrefs; anything else stayed a text segment.
      anchor.href = segment.href
      anchor.textContent = segment.value
      // A same-tab navigation would leave the call, which is the one thing a
      // click in this panel must never do.
      anchor.target = "_blank"
      anchor.rel = "noopener noreferrer nofollow"
      // The meeting's own URL is nobody else's business, and nothing is
      // prefetched or unfurled: the anchor is inert until it is clicked.
      anchor.referrerPolicy = "no-referrer"
      host.append(anchor)
    }
  }

  /** The panel's own empty state: open before anyone has spoken, it used to be a
   * blank rectangle that gave no clue whether capture was working. */
  function emptyNote(): HTMLElement {
    const note = document.createElement("p")
    note.className = "pn-panel-empty"
    note.textContent = query
      ? "Nothing in this meeting matches that yet."
      : "Nothing captured yet. Lines appear here as people speak, and chat lands on the same timeline."
    return note
  }

  function render(): void {
    const timeline = mergeTimeline(latestTranscript, latestChat, latestNotes, latestParticipantEvents).filter(matches)
    // Capture BEFORE rebuilding: replaceChildren can disturb scrollTop, and any
    // scroll events it fires must not flip stickToBottom. If the user scrolled up to
    // read, we restore their exact position instead of auto-scrolling to the bottom.
    const stick = stickToBottom
    const prevTop = body.scrollTop
    body.replaceChildren()
    if (timeline.length === 0) {
      body.append(emptyNote())
      return
    }
    for (const entry of timeline) {
      const isNote = entry.kind === "note"
      const isPresence = entry.kind === "join" || entry.kind === "leave"
      const isBookmark = isNote && entry.text.trim() === ""
      // Bookmarks and presence markers have no body — just the heading line.
      const noBody = isBookmark || isPresence
      // Voice reads down the left; chat and presence markers align to the right so
      // they are visually distinct from what was spoken aloud. Notes stay left (the
      // recorder's own left-margin marks).
      const alignRight = entry.kind === "chat" || isPresence

      const block = document.createElement("div")
      block.className = alignRight ? "pn-turn is-right" : "pn-turn"
      // Presence markers take the participant's own colour (like their speech/chat);
      // notes keep the fixed amber accent.
      block.style.setProperty("--pn-turn-color", isNote ? NOTE_COLOR : colorFor(entry.speaker))

      const inner = document.createElement("div")

      const head = document.createElement("p")
      head.className = "pn-turn-head"
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
      const clock = document.createElement("span")
      clock.className = "pn-turn-clock"
      clock.textContent = formatClock(entry.at)
      head.append(document.createTextNode(label), clock)
      inner.append(head)

      if (!noBody) {
        const text = document.createElement("p")
        text.className = "pn-turn-text"
        appendLinkified(text, entry.text)
        inner.append(text)
      }
      block.append(inner)
      body.append(block)
    }
    if (stick) scrollToBottom()
    else body.scrollTop = prevTop
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
