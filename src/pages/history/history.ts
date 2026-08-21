import { CAPTION_LANGUAGES } from "../../shared/languages"
import { sendToBackground } from "../../shared/messages"
import { getLocal, getSettings, setLocal } from "../../shared/storage"
import type { Meeting } from "../../shared/types"

const list = document.querySelector<HTMLElement>("#list")!
const search = document.querySelector<HTMLInputElement>("#search")!
const searchBox = document.querySelector<HTMLElement>(".search")!
const count = document.querySelector<HTMLElement>("#count")!
const retentionNote = document.querySelector<HTMLElement>("#retention-note")!
const openFolder = document.querySelector<HTMLButtonElement>("#open-folder")!
const snack = document.querySelector<HTMLElement>("#snack")!
const snackText = document.querySelector<HTMLElement>("#snack-text")!
const snackAction = document.querySelector<HTMLButtonElement>("#snack-action")!

const UNDO_MS = 10000
const DONE_MS = 4000

let meetings: Meeting[] = []
let query = ""

// --- the transient outcome region -------------------------------------------
// Every action on this page reports what happened here: a download that landed,
// a delete that can still be undone, a request that failed. Before this the
// success path was silent and the failure path was a native alert().
let snackTimer: ReturnType<typeof setTimeout> | undefined
let onAction: (() => void) | undefined

function say(text: string, action?: { label: string; run: () => void }, ms = DONE_MS): void {
  snackText.textContent = text
  onAction = action?.run
  snackAction.textContent = action?.label ?? ""
  snackAction.hidden = !action
  snack.hidden = false
  if (snackTimer) clearTimeout(snackTimer)
  snackTimer = setTimeout(dismiss, ms)
}

function dismiss(): void {
  snack.hidden = true
  onAction = undefined
}

snackAction.addEventListener("click", () => {
  const run = onAction
  dismiss()
  run?.()
})

// --- data -------------------------------------------------------------------

async function load(): Promise<void> {
  meetings = (await getLocal<Meeting[]>("meetings")) ?? []
  const settings = await getSettings()
  retentionNote.textContent =
    `History keeps the last ${settings.retentionLimit} meetings; after that the oldest entry drops off. ` +
    "The .md files already in your Downloads folder are never touched. Change the limit in Settings."
  render()
}

const monthLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" })

const languageLabel = (tag: string): string => {
  const lang = CAPTION_LANGUAGES.find((l) => l.value === tag)
  return lang ? `${lang.flag} ${lang.code}` : tag
}

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

function button(label: string, className: string, onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const btn = el("button", className, label)
  btn.type = "button"
  btn.addEventListener("click", () => onClick(btn))
  return btn
}

// --- rendering --------------------------------------------------------------

function row(meeting: Meeting): HTMLElement {
  const started = new Date(meeting.startedAt)
  const visits = meeting.visits?.length ?? 0

  const when = el("div", "when")
  when.append(
    el("b", "", started.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })),
    document.createTextNode(started.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })),
  )

  const meta = el("div", "meta")
  meta.append(tag(`${meeting.transcript.length} turns`))
  if (meeting.language) meta.append(tag(languageLabel(meeting.language)))
  if (visits > 1) meta.append(tag(`${visits} visits`))
  if (meeting.isPrivate) meta.append(tag("Private", "tag-private"))

  const actions = el("div", "actions")
  actions.append(
    button("Download", "btn btn-sm", (btn) => void download(meeting, btn)),
    button("Delete", "btn btn-sm btn-danger", () => void remove(meeting)),
  )

  const body = el("div", "meeting-body")
  body.append(when, el("div", "title", meeting.title), meta, actions)

  const item = el("div", "turn meeting")
  // Colour carries the one distinction that matters in a list of meetings: a
  // private one went somewhere else on disk. Everything else stays neutral.
  item.style.setProperty("--turn-color", meeting.isPrivate ? "var(--accent)" : "var(--rule-2)")
  item.append(body)
  return item
}

function emptyState(): HTMLElement {
  const box = el("div", "empty")
  if (query) {
    box.append(
      el("h2", "", "Nothing matches that"),
      el("p", "", `No saved meeting has "${query}" in its title.`),
      button("Clear the filter", "btn", () => {
        search.value = ""
        query = ""
        render()
      }),
    )
    return box
  }
  box.append(
    el("h2", "", "No meetings saved yet"),
    el(
      "p",
      "",
      "Join a Google Meet call and Plática Notes starts capturing on its own: there is nothing to " +
        "switch on. When the call ends, the transcript is written to your Downloads folder and appears here.",
    ),
  )
  const link = el("a", "btn", "Read the user manual")
  link.href = "help.html"
  link.target = "_blank"
  box.append(link)
  return box
}

function render(): void {
  // Newest first: the meeting someone came here to find is nearly always recent.
  const visible = [...meetings]
    .reverse()
    .filter((m) => !query || m.title.toLowerCase().includes(query))

  count.textContent =
    meetings.length === 0
      ? ""
      : query
        ? `${visible.length} of ${meetings.length}`
        : `${meetings.length} saved`
  retentionNote.hidden = meetings.length === 0
  // Nothing to filter yet: an empty search field on an empty page is furniture.
  searchBox.hidden = meetings.length === 0

  if (visible.length === 0) {
    list.replaceChildren(emptyState())
    return
  }

  const nodes: HTMLElement[] = []
  let month = ""
  for (const meeting of visible) {
    const label = monthLabel(meeting.startedAt)
    if (label !== month) {
      month = label
      nodes.push(el("h2", "month", label))
    }
    nodes.push(row(meeting))
  }
  list.replaceChildren(...nodes)
}

// --- actions ----------------------------------------------------------------

async function download(meeting: Meeting, btn: HTMLButtonElement): Promise<void> {
  const label = btn.textContent ?? "Download"
  btn.disabled = true
  btn.textContent = "Saving…"
  const response = await sendToBackground({ kind: "downloadMeeting", meetingId: meeting.id })
  btn.disabled = false
  btn.textContent = label
  if (response.ok) say(`Saved "${meeting.title}" to your Downloads folder.`)
  else say(`Could not save that meeting: ${response.error}`)
}

async function remove(meeting: Meeting): Promise<void> {
  // No confirmation dialog and no soft delete: the row goes, and the action stays
  // reversible for ten seconds. A transcript that exists nowhere else deserves a
  // way back more than it deserves an extra click.
  const index = meetings.findIndex((m) => m.id === meeting.id)
  const response = await sendToBackground({ kind: "deleteMeeting", meetingId: meeting.id })
  if (!response.ok) {
    say(`Could not delete that meeting: ${response.error}`)
    return
  }
  say(`Deleted "${meeting.title}".`, { label: "Undo", run: () => void restore(meeting, index) }, UNDO_MS)
}

async function restore(meeting: Meeting, index: number): Promise<void> {
  // Re-read rather than replaying a stale array: a meeting may have finalized
  // while the undo window was open, and clobbering it would be a worse bug than
  // the one this undoes.
  const current = (await getLocal<Meeting[]>("meetings")) ?? []
  if (current.some((m) => m.id === meeting.id)) return
  const next = current.slice()
  next.splice(Math.min(Math.max(index, 0), next.length), 0, meeting)
  await setLocal({ meetings: next })
  say(`Restored "${meeting.title}".`)
}

openFolder.addEventListener("click", () => {
  // Chrome can only open the Downloads root, not a subfolder, so the label says
  // exactly that rather than promising the meeting's own folder.
  chrome.downloads.showDefaultFolder()
})

search.addEventListener("input", () => {
  query = search.value.trim().toLowerCase()
  render()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.meetings) void load()
  if (area === "sync" && changes.settings) void load()
})

void load()
