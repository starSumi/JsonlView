import type { RevealIntent } from './types';
import type { RevealResult } from '@shared/protocol/reveal';

const DEFAULT_MAX_PENDING = 128;
const DEFAULT_TTL_MS = 5_000;

export type RevealOpenResult = RevealResult | { readonly outcome: 'no-view' | 'timeout' | 'superseded' | 'cancelled'; readonly anchorOrdinal: string };
export interface PendingRevealIntent extends RevealIntent {
  readonly complete: (result: RevealResult) => void;
  readonly isAuthorized: () => boolean;
}
export interface RevealTicket {
  readonly result: Promise<RevealOpenResult>;
  readonly taken: boolean;
  readonly clear: () => void;
}
interface Entry { intent: PendingRevealIntent; expiresAt: number; taken: boolean; timer: ReturnType<typeof setTimeout>;
  resolve: (result: RevealOpenResult) => void }

export interface RevealIntentRegistryOptions {
  readonly maxPending?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** Host-local handoff; no URI or source bytes cross the Webview boundary. */
export class RevealIntentRegistry {
  readonly #pending = new Map<string, Entry>();
  readonly #listeners = new Set<(uri: string) => void>();
  readonly #maxPending: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  public constructor(options: RevealIntentRegistryOptions = {}) {
    this.#maxPending = Math.max(1, Math.floor(options.maxPending ?? DEFAULT_MAX_PENDING));
    this.#ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.#now = options.now ?? Date.now;
  }

  public set(uri: string, intent: RevealIntent, isAuthorized: () => boolean = () => true): RevealTicket {
    const now = this.#now();
    this.#pruneExpired(now);
    this.finish(uri, 'superseded');
    while (this.#pending.size >= this.#maxPending) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.finish(oldest, 'superseded');
    }
    let resolve!: (result: RevealOpenResult) => void;
    const result = new Promise<RevealOpenResult>((settle) => { resolve = settle; });
    const hasGrant = (): boolean => { try { return isAuthorized(); } catch { return false; } };
    const entry: Entry = { intent: { ...intent, isAuthorized: hasGrant, complete: (receipt) => {
      if (this.#pending.get(uri) !== entry) return;
      this.#pending.delete(uri); clearTimeout(entry.timer);
      resolve(receipt.outcome === 'shown' && !hasGrant() ? { ...receipt, outcome: 'unauthorized' } : receipt);
    } }, expiresAt: now + this.#ttlMs, taken: false, resolve,
    timer: setTimeout(() => this.finish(uri, entry.taken ? 'timeout' : 'no-view'), this.#ttlMs) };
    this.#pending.set(uri, entry);
    for (const listener of this.#listeners) {
      try { listener(uri); } catch { /* One observer cannot break delivery or its watchdog. */ }
    }
    return { result, get taken() { return entry.taken; }, clear: () => {
      if (this.#pending.get(uri) === entry) this.finish(uri, 'no-view');
    } };
  }

  public take(uri: string): PendingRevealIntent | undefined {
    const now = this.#now();
    this.#pruneExpired(now);
    const entry = this.#pending.get(uri);
    if (entry === undefined || entry.taken) return undefined;
    entry.taken = true;
    return entry.intent;
  }

  public clear(uri: string): void { this.finish(uri, 'no-view'); }

  public clearAll(): void { for (const uri of this.#pending.keys()) this.finish(uri, 'cancelled'); }
  public onQueued(listener: (uri: string) => void): { dispose(): void } {
    this.#listeners.add(listener); return { dispose: () => { this.#listeners.delete(listener); } };
  }
  private finish(uri: string, outcome: 'no-view' | 'timeout' | 'superseded' | 'cancelled'): void {
    const entry = this.#pending.get(uri);
    if (entry === undefined) return;
    this.#pending.delete(uri); clearTimeout(entry.timer);
    entry.resolve({ outcome, anchorOrdinal: entry.intent.anchorOrdinal });
  }

  #pruneExpired(now: number): void {
    for (const [uri, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.finish(uri, 'no-view');
    }
  }
}
