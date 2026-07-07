// MAIN-world capture script injected into Google Meet's embedded Google Chat
// frame (chat.google.com). Google moved the in-meeting chat onto this frame, and
// the local user's OWN outgoing message is never echoed back over the meeting
// page's WebRTC channels — so the only place to observe it is here, at send time.
//
// We wrap fetch/XHR (like the meet page hook) purely to READ the outgoing
// `create_topic` request body and its response id, then postMessage the text up
// to the meeting page (see meet.ts). We never alter the request or response, and
// nothing is sent off-device — same zero-egress contract as the rest of the tool.
//
// Clean reimplementation against the observable request/response shape.

import { isCreateTopicUrl, parseCreateTopicBody, parseCreateTopicResponse } from "./parse"

// The meeting page (chat.google.com's parent) that consumes captured messages.
const MEET_ORIGIN = "https://meet.google.com"

// Forward one captured outgoing message to the meeting page. Best-effort: a
// postMessage failure must never affect the chat frame.
function forward(text: string, messageId?: string): void {
  try {
    window.parent.postMessage({ source: "platica-chatgoogle", text, messageId }, MEET_ORIGIN)
  } catch {
    /* forwarding must never affect the page */
  }
}

function install(): boolean {
  const w = window as unknown as { __platicaChatGoogle?: boolean }
  if (w.__platicaChatGoogle) return false
  w.__platicaChatGoogle = true

  // fetch: read a CLONE of the response so the page's own reader sees a pristine
  // body. The request text is captured synchronously from the body argument; the
  // topic id (dedupe key) is attached from the response when it resolves. Always
  // returns the original promise untouched.
  try {
    const origFetch = window.fetch
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const promise = (origFetch as any).apply(this, args)
      try {
        const input = args[0]
        const url = input instanceof Request ? input.url : String(input)
        if (isCreateTopicUrl(url, location.href)) {
          const init = args[1] as RequestInit | undefined
          const rawBody = typeof init?.body === "string" ? init.body : undefined
          const text = rawBody ? parseCreateTopicBody(rawBody) : null
          if (text) {
            Promise.resolve(promise)
              .then((res: Response) => {
                res
                  .clone()
                  .text()
                  .then((body) => forward(text, parseCreateTopicResponse(body) ?? undefined))
                  .catch(() => forward(text))
              })
              .catch(() => forward(text))
          }
        }
      } catch {
        /* capture setup must never affect the request */
      }
      return promise
    } as typeof fetch
  } catch {
    /* leave fetch untouched on any failure */
  }

  // XHR: stash the URL at open(); at send() capture the request body text, then
  // read the topic id from the response on load. Behaviour is unchanged.
  try {
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest & { __platicaUrl?: string },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        this.__platicaUrl = String(url)
      } catch {
        /* stashing must never affect the request */
      }
      return (origOpen as any).apply(this, [method, url, ...rest])
    } as typeof XMLHttpRequest.prototype.open

    const origSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest & { __platicaUrl?: string },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      try {
        const url = this.__platicaUrl ?? ""
        if (isCreateTopicUrl(url, location.href) && typeof body === "string") {
          const text = parseCreateTopicBody(body)
          if (text) {
            this.addEventListener("load", () => {
              try {
                if (this.status >= 200 && this.status < 300) {
                  forward(text, parseCreateTopicResponse(this.responseText ?? "") ?? undefined)
                } else {
                  forward(text)
                }
              } catch {
                forward(text)
              }
            })
          }
        }
      } catch {
        /* capture setup must never affect the request */
      }
      return (origSend as any).apply(this, arguments as any)
    } as typeof XMLHttpRequest.prototype.send
  } catch {
    /* leave XHR untouched on any failure */
  }

  return true
}

install()
