import { isContextInvalidatedError } from "../../shared/messages"

export class SessionWriter<T> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private closed = false
  private notifiedInvalidated = false
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly write: (snapshot: T) => Promise<void>,
    private readonly getSnapshot: () => T,
    private readonly intervalMs = 1000,
    // Called once if a write fails because the extension context was invalidated
    // (reload/update mid-meeting). The writer then seals itself: retrying a dead
    // chrome.storage is pointless noise, and there is no session left to save.
    private readonly onInvalidated?: () => void,
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
      .then(() => this.write(this.getSnapshot()))
      .catch((error) => {
        if (isContextInvalidatedError(error)) {
          // Orphaned context: stop retrying and notify once. close() makes every
          // later requestWrite a no-op, so no retry storm and no stray console noise.
          if (!this.notifiedInvalidated) {
            this.notifiedInvalidated = true
            this.close()
            this.onInvalidated?.()
          }
          return
        }
        console.error("[platica-notes] session write failed:", error)
      })
    return this.chain
  }
}
