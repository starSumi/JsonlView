import type { RevealIntent } from './types';

const DEFAULT_MAX_PENDING = 128;
const DEFAULT_TTL_MS = 30_000;

export interface RevealIntentRegistryOptions {
  readonly maxPending?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** Host-local handoff; no URI or source bytes cross the Webview boundary. */
export class RevealIntentRegistry {
  readonly #pending = new Map<string, { readonly intent: RevealIntent; readonly expiresAt: number }>();
  readonly #maxPending: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  public constructor(options: RevealIntentRegistryOptions = {}) {
    this.#maxPending = Math.max(1, Math.floor(options.maxPending ?? DEFAULT_MAX_PENDING));
    this.#ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.#now = options.now ?? Date.now;
  }

  public set(uri: string, intent: RevealIntent): void {
    const now = this.#now();
    this.#pruneExpired(now);
    this.#pending.delete(uri);
    while (this.#pending.size >= this.#maxPending) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(uri, { intent, expiresAt: now + this.#ttlMs });
  }

  public take(uri: string): RevealIntent | undefined {
    const now = this.#now();
    this.#pruneExpired(now);
    const entry = this.#pending.get(uri);
    this.#pending.delete(uri);
    return entry?.intent;
  }

  public clear(uri: string): void { this.#pending.delete(uri); }

  public clearAll(): void { this.#pending.clear(); }

  #pruneExpired(now: number): void {
    for (const [uri, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(uri);
    }
  }
}
