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
      cell(meeting.isPrivate ? "private" : "synced"),
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
      void sendToBackground({ kind: "downloadMeeting", meetingId: meeting.id })
    }),
    button("Delete", () => {
      if (confirm(`Delete "${meeting.title}"?`)) {
        void sendToBackground({ kind: "deleteMeeting", meetingId: meeting.id })
      }
    }),
  )
  return td
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button")
  el.textContent = label
  el.addEventListener("click", onClick)
  return el
}

chrome.storage.onChanged.addListener(() => { void load() })
void load()
