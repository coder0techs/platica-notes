import type { ChatMessage, Utterance } from "../../shared/types"
import { isNearBottom, mergeTimeline } from "../../shared/transcript"

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
export function mountTranscriptPanel(opts: { onVisibilityChange?: (visible: boolean) => void } = {}): {
  update(transcript: Utterance[], chat: ChatMessage[]): void
  toggle(): void
  unmount(): void
} {
  let visible = false
  let latestTranscript: Utterance[] = []
  let latestChat: ChatMessage[] = []
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

  const header = document.createElement("div")
  header.style.cssText = HEADER_CSS
  const title = document.createElement("span")
  title.textContent = "Transcript"
  title.style.cssText = `color:#e8eaed;font:500 14px ${FONT};pointer-events:none;`
  const close = document.createElement("button")
  close.type = "button"
  close.textContent = "✕"
  close.style.cssText = CLOSE_CSS
  close.addEventListener("click", () => setVisible(false))
  header.append(title, close)

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

  card.append(header, body, jump)
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
    if (event.target === close) return
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

  function render(): void {
    const timeline = mergeTimeline(latestTranscript, latestChat)
    body.replaceChildren()
    for (const entry of timeline) {
      const block = document.createElement("div")
      block.style.cssText = "margin-bottom:12px;"
      const head = document.createElement("div")
      head.style.cssText = `color:${colorFor(entry.speaker)};font:500 12px ${FONT};margin-bottom:2px;`
      // Chat is tagged so a pasted line is never mistaken for something said aloud.
      const label = entry.kind === "chat" ? `${entry.speaker} (chat)` : entry.speaker
      head.textContent = `${label} ${formatClock(entry.at)}`
      const text = document.createElement("div")
      text.style.cssText =
        "color:#e8eaed;font:400 13px/1.5 Roboto,system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;"
      text.textContent = entry.text
      block.append(head, text)
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
    update(transcript: Utterance[], chat: ChatMessage[]): void {
      latestTranscript = transcript
      latestChat = chat
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
