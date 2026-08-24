import { isContextInvalidatedError } from "../../shared/messages"

export class SessionWriter<T> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private closed = false
  private notifiedInvalidated = false
  private usingFallback = false
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly write: (snapshot: T) => Promise<void>,
    private readonly getSnapshot: () => T,
    private readonly intervalMs = 1000,
    // Called once if a write fails because the extension context was invalidated
    // (reload/update mid-meeting), AFTER a fallback has been chosen if there is
    // one. The caller uses it to tell the user what state capture is now in.
    private readonly onInvalidated?: (recovered: boolean) => void,
    /**
     * Where writes go once this context's own chrome.* handle is dead.
     *
     * An update mid-meeting severs the content script's handle: chrome.storage
     * throws from here on. Sealing the writer (what this used to do) meant the
     * rest of the meeting was simply lost, and the only way back was reloading the
     * page - which drops the user out of the call and, because Meet does not
     * re-send the roster afterwards, costs every speaker name for the remainder.
     *
     * The capture itself never stopped: the MAIN-world hook holds no chrome.*
     * handle and keeps decoding. Only the transport died. So writes fail over to a
     * transport that outlives an update instead, and the writer keeps going.
     */
    private readonly fallbackWrite?: (snapshot: T) => Promise<void>,
  ) {}

  requestWrite(): void {
    // Once closed (after the final writeNow at meeting end), ignore late writes:
    // a stray debounce or out-of-band event must not re-create the session key
    // the background just cleaned up.
    if (this.closed) return
    if (this.timer) {
      this.pending = true
      return
    }
    void this.enqueueWrite()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.pending) {
        this.pending = false
        this.requestWrite()
      }
    }, this.intervalMs)
  }

  /** Final write: cancels any armed trailing write, then persists after all in-flight writes. */
  async writeNow(): Promise<void> {
    // A sealed writer never writes again (normal teardown calls writeNow before
    // close, so this only bites after a context-invalidation seal).
    if (this.closed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = false
    await this.enqueueWrite()
  }

  /** Seal the writer: after this, requestWrite() is a no-op. Call once, after the final writeNow. */
  close(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = false
  }

  /** Writes are serialized so an older snapshot can never overwrite a newer one. */
  private enqueueWrite(): Promise<void> {
    this.chain = this.chain
      .then(() => this.attempt(this.getSnapshot()))
      .catch((error) => {
        if (isContextInvalidatedError(error)) {
          this.seal()
          return
        }
        console.error("[platica-notes] session write failed:", error)
      })
    return this.chain
  }

  /**
   * One snapshot, on the transport that is currently alive.
   *
   * A context-invalidation failure switches transport and retries THE SAME
   * snapshot inside this call, rather than scheduling a fresh write. That keeps
   * the failover inside the chain link the caller is awaiting: the end-of-meeting
   * sequence is writeNow -> close -> finalize, and finalize reads the snapshot
   * back out of storage, so a writeNow that resolved with the switched-to write
   * still in flight would let finalize commit the meeting minus its last words.
   */
  private async attempt(snapshot: T): Promise<void> {
    const transport = this.usingFallback && this.fallbackWrite ? this.fallbackWrite : this.write
    try {
      await transport(snapshot)
    } catch (error) {
      if (!isContextInvalidatedError(error)) throw error
      if (this.usingFallback || !this.fallbackWrite) throw error
      this.usingFallback = true
      this.onInvalidated?.(true)
      await this.attempt(snapshot)
    }
  }

  /**
   * Nowhere left to write: the fallback died too, or there never was one. Stop,
   * because retrying a provably dead channel is only noise, and say so once.
   */
  private seal(): void {
    if (this.notifiedInvalidated) return
    this.notifiedInvalidated = true
    this.close()
    this.onInvalidated?.(false)
  }
}
