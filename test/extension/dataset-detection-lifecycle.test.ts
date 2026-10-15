import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';
import { IntegratedJsonlSession, type IntegratedSessionOptions, type DatasetDetectionReceipt } from '../../src/extension/integrated-session';

const directories: string[] = [];
const sessions: IntegratedJsonlSession[] = [];
const records = [{ messages: [{ role: 'user', content: 'private sample body' }] }];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: Partial<IntegratedSessionOptions> = {}, signal?: AbortSignal, values = records) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-detection-terminal-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.jsonl');
  await writeFile(path, values.map((record) => JSON.stringify(record)).join('\n'));
  const session = await IntegratedJsonlSession.open(path, {
    uri: new URL(`file:///${path.replaceAll('\\', '/')}`).toString(),
    backgroundIndexing: false, deferProfileDetection: true,
    profileDetectionMaxMilliseconds: 5000, ...options,
  }, signal);
  sessions.push(session);
  return session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function start(session: IntegratedJsonlSession, count = 1) {
  const page = await session.getRows({ limit: 20 }, new AbortController().signal);
  expect(page.rows).toHaveLength(count);
  expect(page.rows[0]?.profile?.profileId).toBe('generic');
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('bounded dataset detection lifecycle', () => {
  it('publishes failed rather than swallowing a rejected head, and keeps Generic rows usable', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const session = await fixture({ onDatasetDetection: (receipt) => receipts.push(receipt) });
    const getRows = JsonlFileEngine.prototype.getRows;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      if (request?.onHydrated !== undefined) return Promise.reject(new Error('private path and body'));
      return getRows.call(this, request);
    });
    await start(session);
    expect(session.getSummary().datasetProvenance).toMatchObject({
      status: 'failed', terminal: { stage: 'head-hydration', code: 'detection_failed', retryable: true, action: 'reload' },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'failed', stage: 'head-hydration' });
    expect(JSON.stringify(receipts)).not.toMatch(/private|synthetic|file:|Error/);
    expect((await session.getRows({ limit: 20 }, new AbortController().signal)).rows).toHaveLength(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receipts).toHaveLength(1);
  });

  it.each(['resolve', 'reject'] as const)('times out a non-cooperating read and ignores its late %s exactly once', async (late) => {
    const receipts: DatasetDetectionReceipt[] = [];
    const session = await fixture({ profileDetectionMaxMilliseconds: 10, onDatasetDetection: (receipt) => receipts.push(receipt) });
    const held = deferred<Awaited<ReturnType<JsonlFileEngine['getRows']>>>();
    const getRows = JsonlFileEngine.prototype.getRows;
    let signal: AbortSignal | undefined;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      if (request?.onHydrated !== undefined) { signal = request.signal; return held.promise; }
      return getRows.call(this, request);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await start(session);
    expect(session.getSummary().datasetProvenance?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(true);
    const after = session.getSummary();
    expect(after.datasetProvenance).toMatchObject({ status: 'timeout', terminal: { stage: 'head-hydration', code: 'deadline_exceeded', action: 'reload' } });
    expect(receipts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    if (late === 'resolve') held.resolve({ rows: [], columns: [], hasBefore: false, hasAfter: false, anchorOrdinal: '0', indexedRecords: '0' });
    else held.reject(new Error('late private error'));
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getSummary().profileEpoch).toBe(after.profileEpoch);
    expect(session.getSummary().datasetProvenance).toEqual(after.datasetProvenance);
    expect(receipts).toHaveLength(1);
  });

  it('cancels a pending operation on dispose without publishing or retaining its timer', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const session = await fixture({ onDatasetDetection: (receipt) => receipts.push(receipt) });
    const getRows = JsonlFileEngine.prototype.getRows;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      return request?.onHydrated === undefined ? getRows.call(this, request) : new Promise(() => undefined);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await start(session);
    const updates = vi.fn();
    session.onProgress(updates);
    await session.dispose();
    await vi.advanceTimersByTimeAsync(20);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'cancelled', stage: 'head-hydration', code: 'operation_cancelled' });
    expect(updates).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops sampling after a timed-out tail settles late', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const session = await fixture({ profileDetectionMaxMilliseconds: 1000, onDatasetDetection: (receipt) => receipts.push(receipt) }, undefined, [...records, ...records]);
    const held = deferred<Awaited<ReturnType<JsonlFileEngine['getRows']>>>();
    const sampled = deferred<void>();
    const getRows = JsonlFileEngine.prototype.getRows;
    let detectionReads = 0;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      if (request?.onHydrated !== undefined) {
        detectionReads += 1;
        if (request.direction === 'backward') { sampled.resolve(); return held.promise; }
      }
      return getRows.call(this, request);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await start(session, 2);
    await sampled.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSummary().datasetProvenance).toMatchObject({ status: 'timeout', terminal: { stage: 'profile-sampling' } });
    expect(detectionReads).toBe(2);
    held.resolve({ rows: [], columns: [], hasBefore: false, hasAfter: false, anchorOrdinal: '0', indexedRecords: '1' });
    await vi.advanceTimersByTimeAsync(1);
    expect(detectionReads).toBe(2);
    expect(receipts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans the deadline after success and ignores subsequent caller cancellation', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await fixture({ deferProfileDetection: false, onDatasetDetection: (receipt) => receipts.push(receipt) }, controller.signal);
    expect(session.getSummary().datasetProvenance?.status).toBe('ready');
    expect(receipts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(6000);
    expect(receipts).toHaveLength(1);
    expect(session.getSummary().datasetProvenance?.status).toBe('ready');
  });

  it('cancels a non-deferred opening even when its sampling read never settles', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const sampled = deferred<void>();
    const getRows = JsonlFileEngine.prototype.getRows;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      if (request?.onHydrated !== undefined) { sampled.resolve(); return new Promise(() => undefined); }
      return getRows.call(this, request);
    });
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opening = fixture({ deferProfileDetection: false, onDatasetDetection: (receipt) => receipts.push(receipt) }, controller.signal);
    const result = opening.then(() => undefined, (error: unknown) => error);
    await sampled.promise;
    controller.abort();
    expect(await result).toMatchObject({ message: 'Operation cancelled.' });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the adopted generation when a candidate detection is cancelled', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const session = await fixture({ deferProfileDetection: false, onDatasetDetection: (receipt) => receipts.push(receipt) });
    const before = session.getSummary();
    const held = deferred<Awaited<ReturnType<JsonlFileEngine['getRows']>>>();
    const sampled = deferred<void>();
    const getRows = JsonlFileEngine.prototype.getRows;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      if (request?.onHydrated !== undefined) { sampled.resolve(); return held.promise; }
      return getRows.call(this, request);
    });
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rebuilding = session.rebuildStable(before.snapshot, controller.signal);
    const result = rebuilding.then(() => undefined, (error: unknown) => error);
    await sampled.promise;
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(session.getSummary().snapshot).toEqual(before.snapshot);
    expect(session.getSummary().datasetProvenance).toEqual(before.datasetProvenance);
    expect(receipts.map((receipt) => receipt.status)).toEqual(['ready', 'cancelled']);
    expect(receipts[1]?.sourceEpoch).toBe((before.snapshot.epoch ?? 0) + 1);
    held.reject(new Error('retired candidate'));
    await vi.advanceTimersByTimeAsync(6000);
    expect(session.getSummary().profileEpoch).toBe(before.profileEpoch);
    expect(receipts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes disabled without any sampling read', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const reads = vi.spyOn(JsonlFileEngine.prototype, 'getRows');
    const session = await fixture({ autoDetectProfiles: false, onDatasetDetection: (receipt) => receipts.push(receipt) });
    expect(reads).not.toHaveBeenCalled();
    expect(session.getSummary().datasetProvenance).toMatchObject({ status: 'disabled', terminal: { stage: 'not-started', retryable: false, action: 'enable-auto-detection' } });
    expect(receipts).toHaveLength(1);
  });

  it('rejects an old timeout after profile ABA and retries only the current epoch', async () => {
    const receipts: DatasetDetectionReceipt[] = [];
    const session = await fixture({ profileDetectionMaxMilliseconds: 1000, onDatasetDetection: (receipt) => receipts.push(receipt) });
    const committed = deferred<void>();
    session.onProgress((summary) => {
      if (summary.datasetProvenance?.status === 'ready') committed.resolve();
    });
    const held = deferred<Awaited<ReturnType<JsonlFileEngine['getRows']>>>();
    const getRows = JsonlFileEngine.prototype.getRows;
    let heads = 0;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      if (request?.onHydrated !== undefined && request.anchorOrdinal === undefined && request.direction !== 'backward') {
        heads += 1;
        if (heads === 1) return held.promise;
      }
      return getRows.call(this, request);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await start(session);
    await session.setProfile('generic-agent-events', new AbortController().signal);
    await session.setProfile('generic', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    await committed.promise;
    expect(heads).toBe(2);
    expect(session.getSummary().datasetProvenance?.status).toBe('ready');
    expect(receipts.map((receipt) => receipt.status)).toEqual(['timeout', 'ready']);
    held.reject(new Error('retired attempt'));
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getSummary().datasetProvenance?.status).toBe('ready');
    expect(receipts).toHaveLength(2);
  });

  it('bounds non-deferred detection failure and isolates a throwing receipt sink', async () => {
    const getRows = JsonlFileEngine.prototype.getRows;
    vi.spyOn(JsonlFileEngine.prototype, 'getRows').mockImplementation(function (this: JsonlFileEngine, request) {
      return request?.onHydrated === undefined ? getRows.call(this, request) : Promise.reject(new Error('read failed'));
    });
    const session = await fixture({ deferProfileDetection: false, onDatasetDetection: () => { throw new Error('sink failed'); } });
    expect(session.getSummary().profileId).toBe('generic');
    expect(session.getSummary().datasetProvenance?.status).toBe('failed');
  });
});
