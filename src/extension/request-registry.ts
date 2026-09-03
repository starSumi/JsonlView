export class RequestRegistry {
  private readonly requests = new Map<string, AbortController>();
  private readonly channels = new Map<string, string>();

  public start(requestId: string): AbortSignal {
    if (this.requests.has(requestId)) {
      throw new Error(`Duplicate request id: ${requestId}`);
    }
    const controller = new AbortController();
    this.requests.set(requestId, controller);
    return controller.signal;
  }

  public startLatest(channel: string, requestId: string): AbortSignal {
    const previous = this.channels.get(channel);
    if (previous !== undefined) {
      this.cancel(previous);
    }
    this.channels.set(channel, requestId);
    return this.start(requestId);
  }

  public finish(requestId: string): void {
    this.requests.delete(requestId);
    for (const [channel, activeRequestId] of this.channels) {
      if (activeRequestId === requestId) {
        this.channels.delete(channel);
      }
    }
  }

  public cancel(requestId: string): boolean {
    const controller = this.requests.get(requestId);
    if (controller === undefined) {
      return false;
    }
    controller.abort();
    this.finish(requestId);
    return true;
  }

  public cancelAll(): void {
    for (const controller of this.requests.values()) {
      controller.abort();
    }
    this.requests.clear();
    this.channels.clear();
  }

  public get size(): number {
    return this.requests.size;
  }
}

