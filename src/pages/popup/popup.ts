import { CAPTION_LANGUAGES } from "../../shared/languages"
import { meetingFolder } from "../../shared/paths"
import { ACTIVE_TABS_KEY, getLocal, getSettings, saveSettings, sessionKey } from "../../shared/storage"
import { DEFAULT_SETTINGS, type ActiveSession, type Meeting } from "../../shared/types"

const now = document.querySelector<HTMLElement>("#now")!
const hideUi = document.querySelector<HTMLInputElement>("#hide-ui")!

// Build stamp shown at the bottom of the popup. typeof-guarded so vitest and
// any non-build eval fall back to "dev" instead of throwing ReferenceError.
const buildVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
const buildCommit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev"
const buildInfo = document.querySelector<HTMLParagraphElement>("#build-info")
if (buildInfo) buildInfo.textContent = `v${buildVersion} (${buildCommit})`

// The hide-UI chord is the same physical key everywhere (Alt on Windows/Linux is
// the Option key on macOS, and both set event.altKey), so only the label differs.
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)
const hideShortcut = document.querySelector("#hide-ui-shortcut")
if (hideShortcut) hideShortcut.textContent = isMac ? "⌥⇧H" : "Alt+Shift+H"

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** HH:MM:SS since `startedAt`. Fixed width so the popup does not reflow every hour. */
function elapsed(startedAt: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000))
  return `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`
}

function languageTag(tag: string | undefined): string {
  const lang = CAPTION_LANGUAGES.find((l) => l.value === tag)
  return lang ? `${lang.flag} ${lang.value}` : (tag ?? DEFAULT_SETTINGS.captionLanguage)
}

/** The folder this meeting's .md will land in: literally the path the downloader
 * builds, via the same shared helper, so this cannot promise the wrong place. */
const destination = (isPrivate: boolean, startedAt: string, folderPublic: string, folderPrivate: string): string =>
  `Downloads/${meetingFolder({ isPrivate, startedAt, folderPublic, folderPrivate })}/`

// --- rendering helpers. Every string reaches the DOM as textContent. ---------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function tag(text: string, extra = ""): HTMLSpanElement {
  return el("span", extra ? `tag ${extra}` : "tag", text)
}

interface View {
  /** Which reserved colour the rail takes: red only while capture is live. */
  rail: string
  state: string
  live: boolean
  clock?: string
  title?: string
  tags?: HTMLElement[]
  path?: string
  note?: string
}

function render(view: View): void {
  const body = el("div", "turn-body")

  // Only a live capture takes the reserved red; every other state stays in the
  // muted body colour, which also keeps the label above the contrast floor.
  const state = el("p", view.live ? "now-state is-live" : "now-state")
  const dot = el("span", view.live ? "rec-dot" : "rec-dot is-idle")
  state.append(dot, document.createTextNode(view.state))
  if (view.clock) state.append(el("span", "now-clock data", view.clock))
  body.append(state)

  if (view.title) body.append(el("p", "now-title", view.title))
  if (view.tags?.length) {
    const meta = el("div", "now-meta")
    meta.append(...view.tags)
    body.append(meta)
  }
  if (view.path) body.append(el("p", "now-path", view.path))
  if (view.note) body.append(el("p", "hint now-note", view.note))

  const turn = el("div", "turn")
  turn.append(body)
  now.style.setProperty("--turn-color", view.rail)
  now.replaceChildren(turn)
  now.removeAttribute("aria-busy")
}

// --- state ------------------------------------------------------------------

let tick: ReturnType<typeof setInterval> | undefined

async function currentTabId(): Promise<number | undefined> {
  // Reading `id` needs no "tabs" permission; that only gates url/title/favIcon.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id
}

async function refresh(): Promise<void> {
  const [settings, activeTabs, tabId] = await Promise.all([
    getSettings(),
    getLocal<number[]>(ACTIVE_TABS_KEY),
    currentTabId(),
  ])
  hideUi.checked = settings.hideUi

  const tabs = activeTabs ?? []
  // Prefer the tab the user is looking at; otherwise report whichever tab is
  // recording, because "somewhere else" still beats implying nothing is running.
  const target = tabId !== undefined && tabs.includes(tabId) ? tabId : tabs[0]
  const session = target === undefined ? undefined : await getLocal<ActiveSession>(sessionKey(target))

  if (tick) clearInterval(tick)
  tick = undefined

  if (session) {
    const elsewhere = target !== tabId
    // `recording` is absent on legacy sessions, where it meant "recording".
    const live = session.recording !== false
    const tags: HTMLElement[] = [tag(languageTag(session.captionLanguage ?? settings.captionLanguage))]
    if (session.isPrivate) tags.push(tag("Private", "tag-private"))
    tags.push(tag(`${session.transcript.length} turns`))

    const paint = (): void =>
      render({
        rail: live ? "var(--rec)" : "var(--ink-2)",
        state: live ? (elsewhere ? "Recording in another tab" : "Recording") : "Capture paused",
        live,
        clock: elapsed(session.startedAt),
        title: session.title,
        tags,
        path: destination(session.isPrivate, session.startedAt, settings.folderPublic, settings.folderPrivate),
        note: live
          ? undefined
          : "Nothing is being captured. Resume it from the Recording control in the call.",
      })
    paint()
    // The clock is the only thing that moves, and only while the popup is open.
    tick = setInterval(paint, 1000)
    return
  }

  const meetings = (await getLocal<Meeting[]>("meetings")) ?? []
  const last = meetings[meetings.length - 1]
  render({
    rail: "var(--rule-2)",
    state: "Not in a meeting",
    live: false,
    title: last?.title,
    tags: last
      ? [tag(new Date(last.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }))]
      : undefined,
    note: last
      ? "That was the last meeting saved. Join a Google Meet call and capture starts on its own."
      : "Join a Google Meet call and capture starts on its own: there is nothing to switch on.",
  })
}

hideUi.addEventListener("change", () => {
  void saveSettings({ hideUi: hideUi.checked })
})

// A meeting can start, pause or end while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) return void refresh()
  if (area !== "local") return
  if (Object.keys(changes).some((key) => key === ACTIVE_TABS_KEY || key === "meetings" || key.startsWith("session_"))) {
    void refresh()
  }
})

void refresh()
