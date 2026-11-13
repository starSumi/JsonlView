export class AcpOperationLifetime {
  private openValue = false;
  private cancellation = new AbortController();
  private readonly active = new Set<Promise<void>>();

  get isOpen(): boolean {
    return this.openValue;
  }

  get signal(): AbortSignal {
    return this.cancellation.signal;
  }

  open(): void {
    if (this.cancellation.signal.aborted) this.cancellation = new AbortController();
    this.openValue = true;
  }

  run(operation: () => Promise<void>): Promise<void> {
    if (!this.openValue) return Promise.resolve();
    const pending = Promise.resolve().then(async () => {
      if (this.openValue) await operation();
    });
    this.active.add(pending);
    void pending.finally(() => this.active.delete(pending)).catch(() => {});
    return pending;
  }

  close(): Promise<void> {
    this.openValue = false;
    this.cancellation.abort();
    return Promise.allSettled([...this.active]).then(() => {});
  }
}
