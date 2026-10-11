import { MAX_PROTOCOL_REQUEST_ID_LENGTH } from './protocol';

/**
 * Owns request-scoped cancellation at the transport boundary. The registry
 * never retains completed requests and does not carry provider or UI state.
 */
export class CancellationRegistry {
  private readonly requests = new Map<string, AbortController>();
  private readonly channels = new Map<string, string>();

  public start(requestId: string): AbortSignal {
    assertRequestId(requestId);
    if (this.requests.has(requestId)) {
      throw new Error(`Duplicate request id: ${requestId}`);
    }
    const controller = new AbortController();
    this.requests.set(requestId, controller);
    return controller.signal;
  }

  public startLatest(channel: string, requestId: string): AbortSignal {
    // Validate and reserve the new request before touching the previous
    // channel owner. Invalid or duplicate starts must leave active work
    // unchanged.
    assertRequestId(requestId);
    if (this.requests.has(requestId)) {
      throw new Error(`Duplicate request id: ${requestId}`);
    }
    const controller = new AbortController();
    const previous = this.channels.get(channel);
    this.requests.set(requestId, controller);
    this.channels.set(channel, requestId);
    if (previous !== undefined) {
      this.cancel(previous);
    }
    return controller.signal;
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

function assertRequestId(requestId: string): void {
  if (typeof requestId !== 'string'
    || requestId.length === 0
    || requestId.length > MAX_PROTOCOL_REQUEST_ID_LENGTH) {
    throw new Error('Invalid request id.');
  }
}
