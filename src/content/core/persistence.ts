export class SessionWriter<T> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private closed = false
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly write: (snapshot: T) => Promise<void>,
    private readonly getSnapshot: () => T,
    private readonly intervalMs = 1000,
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
        console.error("[platica-notes] session write failed:", error)
      })
    return this.chain
  }
}
