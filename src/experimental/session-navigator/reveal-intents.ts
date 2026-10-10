import type { RevealIntent } from './types';

/** Host-local handoff; no URI or source bytes cross the Webview boundary. */
export class RevealIntentRegistry {
  readonly #pending = new Map<string, RevealIntent>();

  public set(uri: string, intent: RevealIntent): void {
    this.#pending.set(uri, intent);
  }

  public take(uri: string): RevealIntent | undefined {
    const intent = this.#pending.get(uri);
    this.#pending.delete(uri);
    return intent;
  }

  public clear(uri: string): void { this.#pending.delete(uri); }

  public clearAll(): void { this.#pending.clear(); }
}
