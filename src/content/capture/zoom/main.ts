// Zoom web client capture. Runs in the page MAIN world at document_start so it can
// claim `window.Redux` before the client's bundle assigns it, then wraps store
// creation and reads the actions that carry the live transcript. Decoded events are
// dispatched to the isolated-world adapter as CustomEvents on `document` (see
// ../protocol.ts).
//
// Read-only: every wrapper calls straight through to the real function, and nothing
// is ever dispatched into Zoom's store.
//
// Clean reimplementation. Only the shape of Zoom's own public page state is used; no
// third-party source code is derived from.

import { RTC_EVENT } from "../protocol"
import type { CaptureEvent } from "../protocol"
import { ZoomMapper } from "./map"

// The web client is the only reachable surface: the desktop app is invisible to any
// extension. Its meeting pages look like /wc/<id>/join or /wc/<id>/start.
const MEETING_PATH = /^\/wc\/(?:join\/)?\d+/

// How long to wait for the client's Redux global before deciding this build is not
// one we can read. Generous: the bundle is large and a cold load can be slow.
const REDUX_WAIT_MS = 15_000

const mapper = new ZoomMapper()

function dispatch(event: CaptureEvent): void {
  try {
    document.dispatchEvent(new CustomEvent(RTC_EVENT, { detail: JSON.stringify(event) }))
  } catch {
    /* a dispatch failure must never affect the page */
  }
}

let lastTitle = ""
let announcedJoin = false

function drain(action: unknown): void {
  try {
    for (const event of mapper.map(action)) dispatch(event)
    if (mapper.title && mapper.title !== lastTitle) {
      lastTitle = mapper.title
      dispatch({ type: "meeting-title", title: mapper.title })
    }
    if (mapper.hasJoined && !announcedJoin) {
      announcedJoin = true
      dispatch({ type: "joined" })
    }
  } catch {
    /* capture must never throw into Zoom's reducer */
  }
}

interface ReduxLike {
  createStore?: unknown
  legacy_createStore?: unknown
  configureStore?: unknown
}

let hooked = false

/**
 * Wrap every store factory the client might use. Each wrapper installs a pass-through
 * reducer that observes the action and returns the real result untouched.
 */
function hookRedux(redux: unknown): void {
  if (hooked || typeof redux !== "object" || redux === null) return
  const target = redux as ReduxLike & Record<string, unknown>
  let wrapped = false

  for (const name of ["createStore", "legacy_createStore"] as const) {
    const original = target[name]
    if (typeof original !== "function") continue
    target[name] = function (this: unknown, reducer: unknown, ...rest: unknown[]) {
      const observed =
        typeof reducer === "function"
          ? (state: unknown, action: unknown) => {
              drain(action)
              return (reducer as (s: unknown, a: unknown) => unknown)(state, action)
            }
          : reducer
      return (original as (r: unknown, ...a: unknown[]) => unknown).call(this, observed, ...rest)
    }
    wrapped = true
  }

  const configureStore = target.configureStore
  if (typeof configureStore === "function") {
    target.configureStore = function (this: unknown, options: unknown) {
      if (options && typeof options === "object") {
        const opts = options as { reducer?: unknown }
        if (typeof opts.reducer === "function") {
          const real = opts.reducer as (s: unknown, a: unknown) => unknown
          opts.reducer = (state: unknown, action: unknown) => {
            drain(action)
            return real(state, action)
          }
        }
      }
      return (configureStore as (o: unknown) => unknown).call(this, options)
    }
    wrapped = true
  }

  if (!wrapped) return
  hooked = true
  // Armed: we will see every action from here on, so silence from now on is a quiet
  // meeting (or captions switched off), not a broken hook.
  dispatch({ type: "health", code: "channel-open" })
}

// Claim the global before the client's bundle assigns it. An accessor means the hook
// lands the instant Redux appears, with no dependency on script load order — unlike
// waiting for a specific bundle's onload, which breaks whenever Zoom renames a chunk.
// Also runs in the PWA iframe: this script is registered with allFrames, so the frame
// gets its own copy rather than needing to be reached from the top document.
function claimReduxGlobal(): void {
  const w = window as unknown as Record<string, unknown> & { __platicaZoom?: boolean }
  if (w.__platicaZoom) return
  w.__platicaZoom = true

  for (const key of ["Redux", "RTK"]) {
    const existing = w[key]
    if (existing !== undefined) {
      hookRedux(existing)
      continue
    }
    let held: unknown
    try {
      Object.defineProperty(w, key, {
        configurable: true,
        get: () => held,
        set: (value: unknown) => {
          held = value
          hookRedux(value)
        },
      })
    } catch {
      /* another extension may already own this property; nothing we can do */
    }
  }

  // If the global never shows up on a meeting page, this is not a client build we can
  // read. Say so, so the adapter reports it instead of recording an empty file.
  setTimeout(() => {
    if (hooked || !MEETING_PATH.test(location.pathname)) return
    dispatch({ type: "health", code: "unsupported-client" })
  }, REDUX_WAIT_MS)
}

claimReduxGlobal()
