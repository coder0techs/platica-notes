const PULSE_ID = "platica-pulse"

/** Brief top-bar flash confirming a storage write happened. */
export function pulseActivity(): void {
  let bar = document.getElementById(PULSE_ID)
  if (!bar) {
    bar = document.createElement("div")
    bar.id = PULSE_ID
    bar.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:3px;z-index:2147483647;" +
      "pointer-events:none;transition:background-color .3s ease-in;background-color:transparent;"
    document.documentElement.appendChild(bar)
  }
  bar.style.backgroundColor = "#6750a4"
  setTimeout(() => { bar.style.backgroundColor = "transparent" }, 1500)
}

export function showToast(message: string): void {
  const toast = document.createElement("div")
  toast.textContent = message
  toast.style.cssText =
    "position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#1f1f1f;color:#fff;" +
    "padding:10px 16px;border-radius:8px;font:14px system-ui;z-index:2147483647;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.3);"
  document.documentElement.appendChild(toast)
  setTimeout(() => toast.remove(), 5000)
}

/** Per-meeting privacy control: local-only vs allowed-to-upload. */
export function mountPrivacyPill(
  initialLocalOnly: boolean,
  onChange: (localOnly: boolean) => void,
): void {
  let localOnly = initialLocalOnly
  const pill = document.createElement("button")
  pill.style.cssText =
    "position:fixed;bottom:88px;left:16px;z-index:2147483647;border:none;color:#fff;" +
    "padding:6px 12px;border-radius:999px;font:12px system-ui;cursor:pointer;opacity:.85;"
  pill.title = "Plática Notes: where this transcript may go"
  const render = () => {
    pill.textContent = localOnly ? "🔒 Local only" : "☁️ Drive after meeting"
    pill.style.background = localOnly ? "#2e7d32" : "#1565c0"
  }
  pill.addEventListener("click", () => {
    localOnly = !localOnly
    render()
    onChange(localOnly)
  })
  render()
  document.documentElement.appendChild(pill)
}
