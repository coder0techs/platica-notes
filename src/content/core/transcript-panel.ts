import type { Utterance } from "../../shared/types"
import { isNearBottom, mergeUtterances } from "../../shared/transcript"

const RERENDER_THROTTLE_MS = 400

// Stable per-speaker colors, assigned in first-seen order and cycled. Meet-native
// accent hues so names read as distinct without a legend.
const SPEAKER_COLORS = ["#8ab4f8", "#81c995", "#fdd663", "#f28b82", "#c58af9", "#78d9ec"]

const FONT = "'Google Sans',Roboto,system-ui,sans-serif"

const PILL_CSS =
  "position:fixed;right:16px;bottom:84px;z-index:2147483647;height:34px;" +
  "display:flex;align-items:center;gap:6px;background:rgba(32,33,36,.92);color:#e8eaed;" +
  "border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:0 14px;" +
  `font:500 13px ${FONT};cursor:pointer;`

const CARD_CSS =
  "position:fixed;right:16px;bottom:84px;z-index:2147483647;width:320px;max-height:60vh;" +
  "display:flex;flex-direction:column;background:rgba(32,33,36,.96);" +
  "border:1px solid rgba(255,255,255,.14);border-radius:12px;" +
  "box-shadow:0 6px 24px rgba(0,0,0,.4);overflow:hidden;"

const HEADER_CSS =
  "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;" +
  "padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1);"

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

/**
 * A self-contained floating transcript widget mounted bottom-right. Collapsed it
 * is a small "Transcript" pill; expanded it is a scrollable card showing the live,
 * merged transcript. It owns its own open/closed state and does not touch the
 * top-center meeting controls. Returns `update` (feed it the raw per-segment
 * transcript; it merges before rendering) and `unmount`.
 */
export function mountTranscriptPanel(): {
  update(utterances: Utterance[]): void
  unmount(): void
} {
  let expanded = false
  let latest: Utterance[] = []
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

  const pill = document.createElement("button")
  pill.type = "button"
  pill.textContent = "📄 Transcript"
  pill.style.cssText = PILL_CSS
  pill.addEventListener("click", () => setExpanded(true))

  const card = document.createElement("div")
  card.style.cssText = CARD_CSS
  card.style.display = "none"

  const header = document.createElement("div")
  header.style.cssText = HEADER_CSS
  const title = document.createElement("span")
  title.textContent = "Transcript"
  title.style.cssText = `color:#e8eaed;font:500 14px ${FONT};`
  const close = document.createElement("button")
  close.type = "button"
  close.textContent = "✕"
  close.style.cssText = CLOSE_CSS
  close.addEventListener("click", () => setExpanded(false))
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
  document.documentElement.append(pill, card)

  function scrollToBottom(): void {
    body.scrollTop = body.scrollHeight
  }

  function updateJumpVisibility(): void {
    jump.style.display = expanded && !stickToBottom ? "block" : "none"
  }

  function setExpanded(next: boolean): void {
    expanded = next
    card.style.display = next ? "flex" : "none"
    pill.style.display = next ? "none" : "flex"
    if (next) {
      stickToBottom = true
      render()
      scrollToBottom()
      updateJumpVisibility()
    }
  }

  function render(): void {
    const merged = mergeUtterances(latest)
    body.replaceChildren()
    for (const utterance of merged) {
      const block = document.createElement("div")
      block.style.cssText = "margin-bottom:12px;"
      const head = document.createElement("div")
      head.style.cssText = `color:${colorFor(utterance.speaker)};font:500 12px ${FONT};margin-bottom:2px;`
      head.textContent = `${utterance.speaker} ${formatClock(utterance.startedAt)}`
      const text = document.createElement("div")
      text.style.cssText =
        "color:#e8eaed;font:400 13px/1.5 Roboto,system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;"
      text.textContent = utterance.text
      block.append(head, text)
      body.append(block)
    }
    if (stickToBottom) scrollToBottom()
  }

  // Leading-edge render, then a coalesced trailing render at most once per
  // RERENDER_THROTTLE_MS while updates keep arriving. No work while collapsed.
  function scheduleRender(): void {
    if (!expanded) return
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
    update(utterances: Utterance[]): void {
      latest = utterances
      scheduleRender()
    },
    unmount(): void {
      if (throttleTimer !== null) window.clearTimeout(throttleTimer)
      pill.remove()
      card.remove()
    },
  }
}
