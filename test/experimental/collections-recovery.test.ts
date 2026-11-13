import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionsStore } from '../../src/infrastructure/navigator/collections-store';
import { CollectionsMutationRecovery, COLLECTIONS_PENDING_PREFIX } from '../../src/experimental/session-navigator/collections-recovery';

let root: string;
let store: CollectionsStore;
let values: Map<string, unknown>;
function state() {
  return { keys: () => [...values.keys()], get: (key: string) => values.get(key),
    update: vi.fn(async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); }) };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jsonlview-collections-recovery-'));
  store = await CollectionsStore.open(join(root, 'metadata.sqlite')); values = new Map();
});
afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }); });
const input = () => ({ expectedRevision: store.listCollections().metadataRevision, action: 'createCollection' as const,
  payload: { displayName: 'Once' } });

describe('Collections accepted-command recovery', () => {
  it.each(['acceptance', 'effect'] as const)('recovers the original command after %s COMMIT response loss and process restart', async (stage) => {
    const persistence = state(); const recovery = new CollectionsMutationRecovery(persistence); const command = input();
    const loseCommitResponse = <T>(operation: () => T): T => {
      const original = DatabaseSync.prototype.exec; let writer = false;
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        original.call(this, sql); if (sql === 'BEGIN IMMEDIATE') writer = true;
        if (sql === 'COMMIT' && writer) { writer = false; throw new Error('lost response'); }
      });
      try { return operation(); } finally { exec.mockRestore(); }
    };
    const accept = store.acceptPendingMutation.bind(store); const apply = store.applyMutation.bind(store);
    const response = stage === 'acceptance'
      ? vi.spyOn(store, 'acceptPendingMutation').mockImplementationOnce((pending) => loseCommitResponse(() => accept(pending)))
      : vi.spyOn(store, 'applyMutation').mockImplementationOnce((pending, guard) => loseCommitResponse(() => apply(pending, guard)));
    try { await expect(recovery.execute(store, command)).rejects.toThrow('METADATA_UNAVAILABLE'); }
    finally { response.mockRestore(); }
    expect(store.listPendingMutations()).toHaveLength(1); const [originalPending] = store.listPendingMutations();
    expect(store.listCollections().items).toHaveLength(stage === 'acceptance' ? 0 : 1);
    store.close(); store = await CollectionsStore.open(join(root, 'metadata.sqlite'));
    await new CollectionsMutationRecovery(state()).recover(store);
    expect(store.listCollections().items).toHaveLength(1); expect(store.listPendingMutations()).toHaveLength(0);
    expect(originalPending).toMatchObject({ expectedRevision: '0', payload: { displayName: 'Once' } });
    expect(persistence.update).not.toHaveBeenCalled();
    await new CollectionsMutationRecovery(state()).execute(store, input());
    expect(store.listCollections().items).toHaveLength(2);
  });

  it('does not apply a command when saving its pending identity fails', async () => {
    const persistence = state(); vi.spyOn(store, 'acceptPendingMutation').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    const apply = vi.spyOn(store, 'applyMutation');
    await expect(new CollectionsMutationRecovery(persistence).execute(store, input())).rejects.toThrow('storage unavailable');
    expect(apply).not.toHaveBeenCalled(); expect(store.listCollections().items).toHaveLength(0);
    expect(store.listPendingMutations()).toHaveLength(0); expect(persistence.update).not.toHaveBeenCalled();
  });

  it('retains the original pending command after receipt-cleanup failure and replays it once', async () => {
    const persistence = state();
    const cleanup = vi.spyOn(store, 'completePendingMutation').mockImplementationOnce(() => { throw new Error('cleanup unavailable'); });
    await expect(new CollectionsMutationRecovery(persistence).execute(store, input())).resolves.toMatchObject({
      operation: 'createCollection', metadataRevision: '1', result: { displayName: 'Once' },
    });
    expect(store.listPendingMutations()).toHaveLength(1); expect(store.listCollections().items).toHaveLength(1);
    cleanup.mockRestore();
    await new CollectionsMutationRecovery(state()).recover(store);
    expect(store.listPendingMutations()).toHaveLength(0); expect(store.listCollections().items).toHaveLength(1);
    expect(persistence.update).not.toHaveBeenCalled();
  });

  it('returns the known successful receipt when cleanup COMMIT succeeds but its response is lost', async () => {
    const complete = store.completePendingMutation.bind(store);
    vi.spyOn(store, 'completePendingMutation').mockImplementationOnce((pending) => {
      const original = DatabaseSync.prototype.exec;
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        original.call(this, sql);
        if (sql === 'COMMIT') throw new Error('lost cleanup COMMIT response');
      });
      try { complete(pending); } finally { exec.mockRestore(); }
    });
    await expect(new CollectionsMutationRecovery(state()).execute(store, input())).resolves.toMatchObject({
      operation: 'createCollection', metadataRevision: '1', changed: true, result: { displayName: 'Once' },
    });
    expect(store.listPendingMutations()).toHaveLength(0); expect(store.listCollections().items).toHaveLength(1);
    store.close(); store = await CollectionsStore.open(join(root, 'metadata.sqlite'));
    await new CollectionsMutationRecovery(state()).recover(store);
    expect(store.listPendingMutations()).toHaveLength(0); expect(store.listCollections().items).toHaveLength(1);
  });

  it('retains an invalid pending command and refuses further mutation', async () => {
    values.set(COLLECTIONS_PENDING_PREFIX + 'invalid', { version: 1, command: {} });
    const recovery = new CollectionsMutationRecovery(state());
    await expect(recovery.recover(store)).rejects.toThrow('METADATA_UNAVAILABLE');
    await expect(recovery.execute(store, input())).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(values.size).toBe(1); expect(store.listCollections().items).toHaveLength(0);
  });

  it('replays a persisted but unapplied command after the process is recreated', async () => {
    const apply = vi.spyOn(store, 'applyMutation').mockImplementationOnce(() => { throw new Error('interrupted before apply'); });
    await expect(new CollectionsMutationRecovery(state()).execute(store, input())).rejects.toThrow('interrupted before apply');
    apply.mockRestore(); expect(store.listPendingMutations()).toHaveLength(1);
    store.close(); store = await CollectionsStore.open(join(root, 'metadata.sqlite'));
    await new CollectionsMutationRecovery(state()).recover(store);
    expect(store.listCollections().items).toHaveLength(1); expect(store.listPendingMutations()).toHaveLength(0);
  });

  it('retains a conflicting pending command and blocks new writes instead of silently rebasing', async () => {
    const persistence = state(); const apply = vi.spyOn(store, 'applyMutation').mockImplementationOnce(() => { throw new Error('interrupted'); });
    await expect(new CollectionsMutationRecovery(persistence).execute(store, input())).rejects.toThrow('interrupted');
    apply.mockRestore(); store.createCollection('Independent action', '0');
    const recovery = new CollectionsMutationRecovery(persistence);
    await expect(recovery.execute(store, input())).rejects.toThrow('REVISION_CONFLICT');
    expect(store.listPendingMutations()).toHaveLength(1); expect(store.listCollections().items).toHaveLength(1);
  });

  it('applies the exact persisted payload even if the caller changes its object during storage', async () => {
    const persistence = state(); const accept = store.acceptPendingMutation.bind(store);
    let release!: () => void;
    vi.spyOn(store, 'acceptPendingMutation').mockImplementationOnce(async (command) => {
      accept(command); await new Promise<void>((resolve) => { release = resolve; });
    });
    const command = input(); const pending = new CollectionsMutationRecovery(persistence).execute(store, command);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    command.payload.displayName = 'Changed after persistence'; release(); await pending;
    expect(store.listCollections().items).toMatchObject([{ displayName: 'Once' }]);
  });

  it('stops further startup replay when the host retires during pending cleanup', async () => {
    const first = '00000000-0000-4000-8000-000000000001'; const second = '00000000-0000-4000-8000-000000000002';
    values.set(COLLECTIONS_PENDING_PREFIX + first, { version: 1, command: { ...input(), requestId: first } });
    values.set(COLLECTIONS_PENDING_PREFIX + second, { version: 1, command: { ...input(), requestId: second, expectedRevision: '1' } });
    const persistence = state(); const complete = store.completePendingMutation.bind(store); let active = true;
    vi.spyOn(store, 'completePendingMutation').mockImplementationOnce((command) => { complete(command); active = false; });
    await expect(new CollectionsMutationRecovery(persistence, () => active).recover(store)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(store.listCollections().items).toHaveLength(1); expect(store.listPendingMutations()).toMatchObject([{ requestId: second }]);
    await new CollectionsMutationRecovery(state()).recover(store);
    expect(store.listCollections().items).toHaveLength(2); expect(store.listPendingMutations()).toHaveLength(0);
    expect(values.size).toBe(2); expect(persistence.update).not.toHaveBeenCalled();
  });

  it('does not persist a new action after the host retires during earlier receipt recovery', async () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    values.set(COLLECTIONS_PENDING_PREFIX + requestId, { version: 1, command: { ...input(), requestId } });
    const persistence = state(); const complete = store.completePendingMutation.bind(store); let active = true;
    const accept = vi.spyOn(store, 'acceptPendingMutation');
    vi.spyOn(store, 'completePendingMutation').mockImplementationOnce((command) => { complete(command); active = false; });
    await expect(new CollectionsMutationRecovery(persistence, () => active).execute(store, input())).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(store.listCollections().items).toHaveLength(1); expect(store.listPendingMutations()).toHaveLength(0);
    expect(accept).not.toHaveBeenCalled(); expect(values.size).toBe(1); expect(persistence.update).not.toHaveBeenCalled();
  });
});
