import { sendToBackground } from "../../shared/messages"
import type { Meeting } from "../../shared/types"

async function load(): Promise<void> {
  const result = await chrome.storage.local.get("meetings")
  const meetings = (result.meetings as Meeting[] | undefined) ?? []
  render([...meetings].reverse())
}

function render(meetings: Meeting[]): void {
  const tbody = document.querySelector("#meetings tbody")!
  tbody.replaceChildren()
  document.querySelector<HTMLElement>("#empty")!.hidden = meetings.length > 0
  for (const meeting of meetings) {
    const row = document.createElement("tr")
    row.append(
      cell(new Date(meeting.startedAt).toLocaleString()),
      cell(meeting.title),
      cell(String(meeting.transcript.length)),
      cell(meeting.isPrivate ? "private" : "—"),
      actionsCell(meeting),
    )
    tbody.append(row)
  }
}

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement("td")
  td.textContent = text
  return td
}

function actionsCell(meeting: Meeting): HTMLTableCellElement {
  const td = document.createElement("td")
  td.append(
    button("Download", () => {
      void request({ kind: "downloadMeeting", meetingId: meeting.id }, "Download failed")
    }),
    button("Delete", () => {
      if (confirm(`Delete "${meeting.title}"?`)) {
        void request({ kind: "deleteMeeting", meetingId: meeting.id }, "Delete failed")
      }
    }),
  )
  return td
}

async function request(
  message: Parameters<typeof sendToBackground>[0],
  failureLabel: string,
): Promise<void> {
  const response = await sendToBackground(message)
  if (!response.ok) alert(`${failureLabel}: ${response.error}`)
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button")
  el.textContent = label
  el.addEventListener("click", onClick)
  return el
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.meetings) void load()
})
void load()
