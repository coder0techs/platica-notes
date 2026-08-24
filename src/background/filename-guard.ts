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

// Shortest truncated URL worth matching a prefix on. Every URL we issue opens with
// the same 44-character `data:` header, so a prefix has to reach well past it
// before it says anything about WHICH download this is. Chrome's own cut is 1024;
// this is only a floor against a mangled short one matching the wrong entry.
const MIN_PREFIX = 128

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
   * Take the name that belongs to a download being determined.
   *
   * Three ways, narrowest first. Exact URL, which only ever hits for a very short
   * transcript. Then the prefix Chrome actually hands back: measured in Chrome
   * 151, a `data:` URL comes back cut to 1024 characters, and every file this
   * extension writes is longer than that, so exact equality misses ALL of them.
   * Only then FIFO order.
   *
   * Order was the sole fallback until the prefix match went in, and it is right
   * only while exactly one of our downloads is in flight. That held by
   * construction - the exports are awaited one after another - but nothing in the
   * type system says so, and when it stops holding the failure is a meeting saved
   * under the debug log's name, which nobody would think to look for. The prefix
   * makes the common case a real identification instead of a bet on ordering.
   *
   * `ours` (Chrome attributes the item to this extension) gates everything past
   * exact equality, so a stale entry can never rename someone else's file.
   */
  claim(url: string, ours: boolean): PendingName | undefined {
    const at = this.pending.findIndex(p => p.url === url)
    if (at >= 0) return this.pending.splice(at, 1)[0]
    if (!ours) return undefined
    if (url.length >= MIN_PREFIX) {
      const byPrefix = this.pending.findIndex(p => p.url.startsWith(url))
      if (byPrefix >= 0) return this.pending.splice(byPrefix, 1)[0]
    }
    return this.pending.shift()
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
    const ours = item.byExtensionId === chrome.runtime.id
    const claimed = guard.claim(item.finalUrl || item.url, ours)
    // Answer exactly once, always. A bare suggest() means "no suggestion from me"
    // and leaves foreign downloads entirely to Chrome: the courtesy the extensions
    // that broke this were missing.
    if (!claimed) {
      // Our own download with no name to give it lands in the Downloads root as a
      // bare "download". Silence here is how that shipped unnoticed, so say it.
      if (ours) {
        console.warn(
          "[platica-notes] a download of ours reached the filename round with no name registered",
          { url: (item.finalUrl || item.url).slice(0, 64), pending: guard.size },
        )
      }
      suggest()
      return
    }
    suggest({ filename: claimed.filename, conflictAction: claimed.conflictAction })
  })
}
