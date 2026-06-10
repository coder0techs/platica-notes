import { DEFAULT_SETTINGS, type Settings } from "./types"

export async function getLocal<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key)
  return result[key] as T | undefined
}

export async function setLocal(items: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(items)
}

export async function removeLocal(keys: string | string[]): Promise<void> {
  await chrome.storage.local.remove(keys)
}

export function withDefaults(stored: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get("settings")
  return withDefaults(result.settings as Partial<Settings> | undefined)
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings()
  await chrome.storage.sync.set({ settings: { ...current, ...patch } })
}

export const sessionKey = (tabId: number): string => `session_${tabId}`
