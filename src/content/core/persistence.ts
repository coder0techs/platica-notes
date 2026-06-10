export class SessionWriter<T> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending = false

  constructor(
    private readonly write: (snapshot: T) => Promise<void>,
    private readonly getSnapshot: () => T,
    private readonly intervalMs = 1000,
  ) {}

  requestWrite(): void {
    if (this.timer) {
      this.pending = true
      return
    }
    void this.writeNow()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.pending) {
        this.pending = false
        this.requestWrite()
      }
    }, this.intervalMs)
  }

  async writeNow(): Promise<void> {
    await this.write(this.getSnapshot())
  }
}
