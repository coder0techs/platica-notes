// Minimal in-memory chrome.* fake for unit-testing the background service worker
// without a browser. Covers the surface the background actually touches:
// storage.local (get/set/remove), storage.sync (get/set), and tabs.get.
//
// Install with `globalThis.chrome = makeChromeMock(...)` in a beforeEach and
// restore in afterEach. `_store` and `_aliveTabs` expose the backing state so a
// test can seed sessions and toggle which tabs are "alive".

export interface ChromeMock {
  storage: {
    local: {
      get(key: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    sync: {
      get(key: string): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
    }
  }
  tabs: {
    get(tabId: number): Promise<{ id: number }>
  }
  _store: Record<string, unknown>
  _aliveTabs: Set<number>
  /** Tabs whose get() rejects with a NON-"no tab" error (transient SW-teardown race). */
  _transientTabs: Set<number>
}

export function makeChromeMock(initialLocal: Record<string, unknown> = {}): ChromeMock {
  const store: Record<string, unknown> = structuredClone(initialLocal)
  const sync: Record<string, unknown> = {}
  const aliveTabs = new Set<number>()
  const transientTabs = new Set<number>()

  const get = async (key: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
    if (key === null || key === undefined) return structuredClone(store)
    if (typeof key === "string") return key in store ? { [key]: structuredClone(store[key]) } : {}
    if (Array.isArray(key)) {
      const out: Record<string, unknown> = {}
      for (const k of key) if (k in store) out[k] = structuredClone(store[k])
      return out
    }
    // object form: defaults
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(key)) out[k] = k in store ? structuredClone(store[k]) : key[k]
    return out
  }

  return {
    storage: {
      local: {
        get,
        set: async (items) => {
          Object.assign(store, structuredClone(items))
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
        },
      },
      sync: {
        get: async (key) => (key in sync ? { [key]: structuredClone(sync[key]) } : {}),
        set: async (items) => {
          Object.assign(sync, structuredClone(items))
        },
      },
    },
    tabs: {
      get: (tabId) => {
        if (transientTabs.has(tabId)) return Promise.reject(new Error("Tabs cannot be edited right now (user may be dragging a tab)."))
        if (aliveTabs.has(tabId)) return Promise.resolve({ id: tabId })
        return Promise.reject(new Error(`No tab with id: ${tabId}.`))
      },
    },
    _store: store,
    _aliveTabs: aliveTabs,
    _transientTabs: transientTabs,
  }
}
