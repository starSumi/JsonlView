import { randomUUID } from 'node:crypto';
import { CollectionsError, type CollectionsMutationCommand, type CollectionsMutationReceipt, type CollectionsPort } from '@application/index';
import { validateCollectionsMutationCommand, type CollectionsMutationInput } from '@infrastructure/navigator/collections-store';

export const COLLECTIONS_PENDING_PREFIX = 'jsonlView.collections.pending.v1.';
const MAX_PENDING = 64;
export interface CollectionsMutationState {
  keys(): readonly string[];
  get(key: string): unknown;
}

/** One host's command queue; SQLite receipts/CAS arbitrate independent hosts. */
export class CollectionsMutationRecovery {
  readonly #state: CollectionsMutationState;
  readonly #isActive: () => boolean;
  readonly #guard: (command: CollectionsMutationCommand) => void;
  #tail: Promise<unknown> = Promise.resolve();
  public constructor(state: CollectionsMutationState, isActive: () => boolean = () => true, guard: (command: CollectionsMutationCommand) => void = () => {}) { this.#state = state; this.#isActive = isActive; this.#guard = guard; }
  public hasPending(store?: CollectionsPort): boolean {
    try { return store === undefined ? this.#state.keys().some((key) => key.startsWith(COLLECTIONS_PENDING_PREFIX)) : store.listPendingMutations().length > 0; }
    catch { return true; }
  }

  public recover(store: CollectionsPort): Promise<void> { return this.enqueue(() => this.replay(store)); }

  public execute(store: CollectionsPort, input: CollectionsMutationInput, guard: () => void = () => {}): Promise<CollectionsMutationReceipt> {
    return this.enqueue(async () => {
      await this.replay(store);
      this.assertActive();
      // Each accepted action is distinct, including two intentional same-name creations.
      const command = structuredClone({ ...input, requestId: randomUUID() }) as CollectionsMutationCommand;
      validateCollectionsMutationCommand(command);
      store.validateMutation(command);
      this.#guard(command); guard();
      await store.acceptPendingMutation(command);
      this.assertActive();
      const receipt = store.applyMutation(command, () => { this.#guard(command); guard(); });
      try { await store.completePendingMutation(command); }
      catch { /* The receipt proves success; retained pending cleanup is retried by recovery. */ }
      return receipt;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation); this.#tail = next.catch(() => undefined); return next;
  }

  private async replay(store: CollectionsPort): Promise<void> {
    this.assertActive();
    const keys = this.#state.keys().filter((key) => key.startsWith(COLLECTIONS_PENDING_PREFIX)).sort();
    if (keys.length > MAX_PENDING) throw new CollectionsError('METADATA_UNAVAILABLE');
    // Validate the entire bounded journal before executing any recovered command.
    const legacy = keys.map((key) => this.readCommand(key));
    if (legacy.length > 0) store.importLegacyMutations(legacy);
    // Read the shared SQLite journal on every pass; window-local Memento snapshots
    // are only read-only legacy inputs and are never used for new acceptance.
    const commands = store.listPendingMutations();
    for (const command of commands) {
      this.assertActive();
      store.applyMutation(command, () => this.#guard(command));
      await store.completePendingMutation(command);
    }
  }

  private assertActive(): void { if (!this.#isActive()) throw new CollectionsError('METADATA_UNAVAILABLE'); }

  private readCommand(key: string): CollectionsMutationCommand {
    try {
      const value = this.#state.get(key);
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'command,version'
        || !('version' in value) || value.version !== 1 || !('command' in value)) throw new Error();
      const command = value.command as CollectionsMutationCommand;
      validateCollectionsMutationCommand(command);
      if (key !== COLLECTIONS_PENDING_PREFIX + command.requestId) throw new Error();
      return command;
    } catch { throw new CollectionsError('METADATA_UNAVAILABLE'); }
  }
}
