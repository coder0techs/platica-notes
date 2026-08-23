// Re-asserts the download filename against other extensions' filename determiners.
//
// `chrome.downloads.download({ filename })` is only a *suggestion*. Chrome runs a
// determination round whenever any installed extension holds a
// `downloads.onDeterminingFilename` listener, and the API contract says every such
// listener must call `suggest` exactly once. An extension that returns early for
// downloads it did not start, without answering, makes Chrome discard our name and
// fall back to one derived from the URL. For the `data:` URLs this extension
// downloads, that default is the bare string "download": no title, no date, no
// folder, no `.md`, dumped in the Downloads root. The transcript inside is intact,
// so nothing is lost, but the file is unidentifiable without opening it.
//
// Observed with Imagus Reborn 2026.8.15 (its listener is registered permanently,
// so every single meeting broke) and DownThemAll! 4.15.1 (registered only while it
// is actively downloading, which is why that one bit occasionally rather than
// always). Both were reported upstream by the colleague who diagnosed this.
//
// The defence is to hold a determiner of our own and answer it with the name we
// asked for. Chrome gives the round to the last-installed extension that supplies a
// suggestion, so a neighbour that actively suggests a different name still outranks
// us and nothing on this side can change that. What this fixes is the far more
// common case: a neighbour that merely stays silent no longer costs us the name.

/** The subset of conflict actions this extension ever asks for. */
export type ConflictAction = "uniquify" | "overwrite"

export interface PendingName {
  /** The exact URL passed to chrome.downloads.download. */
  url: string
  /** Path relative to the Downloads directory, subdirectories included. */
  filename: string
  conflictAction: ConflictAction
}

// A cap so a download that never reaches the determiner (a rejected call, a service
// worker torn down mid-flight) cannot grow the queue without bound. Downloads are
// issued one at a time, so anything beyond a couple of entries is already stale.
const MAX_PENDING = 8

/**
 * The names we have asked Chrome for and not yet seen determined. Pure logic, no
 * chrome.* access, so the matching rules are unit-testable.
 */
export class FilenameGuard {
  private pending: PendingName[] = []

  get size(): number {
    return this.pending.length
  }

  /** Record a name before requesting the download that should carry it. */
  expect(entry: PendingName): void {
    this.pending.push(entry)
    while (this.pending.length > MAX_PENDING) this.pending.shift()
  }

  /** Drop an entry whose download never started (the API call threw). */
  forget(url: string): void {
    const at = this.pending.findIndex(p => p.url === url)
    if (at >= 0) this.pending.splice(at, 1)
  }

  /**
   * Take the name that belongs to a download being determined. Matching is by exact
   * URL first; `ours` (the item is attributed to this extension) then allows a fall
   * back to FIFO order, because Chrome does not promise to hand back a
   * multi-megabyte `data:` URL verbatim. A foreign download that matches nothing
   * claims nothing, so a stale entry can never rename someone else's file.
   *
   * FIFO is safe here only because the exports are sequential: `index.ts` awaits
   * the meeting download before it starts the debug log, and the determination
   * round runs before `chrome.downloads.download()` resolves, so at most one of
   * our own downloads is ever in flight. Issue two concurrently and the two names
   * could swap.
   */
  claim(url: string, ours: boolean): PendingName | undefined {
    const at = this.pending.findIndex(p => p.url === url)
    if (at >= 0) return this.pending.splice(at, 1)[0]
    return ours ? this.pending.shift() : undefined
  }
}

export const filenameGuard = new FilenameGuard()

/**
 * Register the determiner. Must run at service-worker top level: the round happens
 * before `chrome.downloads.download()` resolves, so the listener has to exist
 * before the first download of this worker's life.
 */
export function installFilenameGuard(guard: FilenameGuard = filenameGuard): void {
  const determiner = chrome.downloads?.onDeterminingFilename
  // Absent API: say so rather than throw or go quiet. Throwing here would kill the
  // service worker at top level and take every other feature with it, which is far
  // worse than losing filenames. Failing silently would leave a future reader
  // convinced the guard is working. The `downloads` permission covers this event,
  // so in a shipping build this branch should never be taken.
  if (!determiner) {
    console.warn("[platica-notes] downloads.onDeterminingFilename unavailable; saved files may lose their name")
    return
  }
  determiner.addListener((item, suggest) => {
    const claimed = guard.claim(item.finalUrl || item.url, item.byExtensionId === chrome.runtime.id)
    // Answer exactly once, always. A bare suggest() means "no suggestion from me"
    // and leaves foreign downloads entirely to Chrome: the courtesy the extensions
    // that broke this were missing.
    if (!claimed) {
      suggest()
      return
    }
    suggest({ filename: claimed.filename, conflictAction: claimed.conflictAction })
  })
}
