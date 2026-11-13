import { appendFile, mkdtemp, type open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonlFileEngine } from '../../src/engine';
import { IntegratedJsonlSession } from '../../src/extension/integrated-session/integrated-session';

const directories: string[] = [];
const sessions: IntegratedJsonlSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(contents = `${JSON.stringify({ message: 'x'.repeat(1_000) })}\n`.repeat(6_000)) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-graph-budget-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.jsonl');
  // Larger than the Graph budget, but small enough to have an original-range
  // fingerprint from open. This exercises the real append-validation hash path.
  await writeFile(path, contents);
  const session = await IntegratedJsonlSession.open(path, {
    uri: 'file:///synthetic.jsonl', autoDetectProfiles: false, backgroundIndexing: false,
  });
  sessions.push(session);
  const engine = (session as unknown as { engine: JsonlFileEngine }).engine;
  const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
  return { path, session, engine, handle };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

type PositionalRead = (
  buffer: Buffer, offset: number, length: number, position: number | bigint | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

async function heldQueueFixture() {
  const f = await fixture();
  const original = f.handle.read.bind(f.handle) as PositionalRead;
  const started = deferred();
  const gate = deferred();
  const reads: number[] = [];
  const spy = vi.spyOn(f.handle, 'read') as unknown as { mockImplementation(read: PositionalRead): void };
  spy.mockImplementation(async (buffer, offset, length, position) => {
    const call = reads.length;
    reads.push(0);
    if (call === 0) {
      started.resolve();
      await gate.promise;
    }
    const result = await original(buffer, offset, length, position);
    reads[call] = result.bytesRead;
    return result;
  });
  const activeController = new AbortController();
  const active = f.engine.getRows({ limit: 1, signal: activeController.signal }).catch((error: unknown) => error);
  await started.promise;
  return { ...f, reads, active, release: () => { activeController.abort(); gate.resolve(); } };
}

describe('Graph queue and snapshot-validation budgets', () => {
  it.each([false, true])('does no content reads after an append while queued (deadline expired: %s)', async (expired) => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = await heldQueueFixture();
    try {
      const result = f.session.getGraphRows(new AbortController().signal).catch((error: unknown) => error);
      await appendFile(f.path, '{}\n');
      if (expired) now = 2_000;
      f.release();
      await f.active;
      const settled = await result;
      const graphReads = f.reads.slice(1);
      expect({ calls: graphReads.length, bytes: graphReads.reduce((sum, bytes) => sum + bytes, 0) })
        .toEqual({ calls: 0, bytes: 0 });
      expect(settled).toMatchObject({ code: expired ? 'ABORTED' : 'SOURCE_CHANGED' });
    } finally {
      f.release();
      await f.active;
    }
  });

  it('cancels a queued Graph query before snapshot content reads', async () => {
    const f = await heldQueueFixture();
    try {
      const controller = new AbortController();
      const result = f.session.getGraphRows(controller.signal).catch((error: unknown) => error);
      await appendFile(f.path, '{}\n');
      controller.abort();
      f.release();
      await f.active;
      expect(await result).toMatchObject({ code: 'ABORTED' });
      expect(f.reads.slice(1)).toEqual([]);
    } finally {
      f.release();
      await f.active;
    }
  });

  it.each(['deadline', 'abort'] as const)('stops after a pending stat settles with %s before starting a read', async (stop) => {
    const f = await fixture();
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const started = deferred();
    const gate = deferred();
    const original = f.handle.stat.bind(f.handle);
    vi.spyOn(f.handle, 'stat').mockImplementationOnce(async (options) => {
      started.resolve();
      await gate.promise;
      return original(options);
    });
    const reads = vi.spyOn(f.handle, 'read');
    const controller = new AbortController();
    const result = f.session.getGraphRows(controller.signal).catch((error: unknown) => error);
    try {
      await started.promise;
      if (stop === 'deadline') now = 2_000;
      else controller.abort();
      gate.resolve();
      expect(await result).toMatchObject({ code: 'ABORTED' });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await result;
    }
  });

  it('rejects an append after page hydration using only metadata checks', async () => {
    const f = await fixture();
    const project = vi.fn();
    const hydrated = deferred();
    const finishStat = deferred();
    const originalStat = f.handle.stat.bind(f.handle);
    let statCalls = 0;
    vi.spyOn(f.handle, 'stat').mockImplementation(async (options) => {
      statCalls += 1;
      // Initial observation and the index staging observation precede the
      // post-page observation. Hold the latter after actual hydration.
      if (statCalls === 3) {
        hydrated.resolve();
        await finishStat.promise;
      }
      return originalStat(options);
    });
    const reads = vi.spyOn(f.handle, 'read');
    const result = f.engine.getObservedBackgroundRows({
      direction: 'forward', limit: 1, onHydrated: project,
      scanBudget: { maxExaminedRecords: 1, maxExaminedBytes: '4194304', deadlineEpochMs: Date.now() + 60_000 },
    }).catch((error: unknown) => error);
    try {
      await hydrated.promise;
      expect(project).toHaveBeenCalledTimes(1);
      const callsBeforeAppend = reads.mock.calls.length;
      await appendFile(f.path, '{}\n');
      finishStat.resolve();
      expect(await result).toMatchObject({ code: 'SOURCE_CHANGED' });
      expect(reads).toHaveBeenCalledTimes(callsBeforeAppend);
    } finally {
      finishStat.resolve();
      await result;
    }
  });

  it('keeps stable Graph content bounded and preserves ordinary append snapshot validation', async () => {
    const f = await fixture();
    let bytes = 0;
    const original = f.handle.read.bind(f.handle) as PositionalRead;
    const reads = vi.spyOn(f.handle, 'read') as unknown as { mockImplementation(read: PositionalRead): void };
    reads.mockImplementation(async (buffer, offset, length, position) => {
      const result = await original(buffer, offset, length, position);
      bytes += result.bytesRead;
      return result;
    });
    const graph = await f.session.getGraphRows(new AbortController().signal);
    expect(graph.rows).toHaveLength(100);
    expect(graph.rows.map((row) => row.ref.ordinal)).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    expect(BigInt(graph.scan!.examinedBytes)).toBeLessThanOrEqual(4n * 1024n * 1024n);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    const originalSize = Number((await stat(f.path)).size);
    await appendFile(f.path, '{}\n');
    bytes = 0;
    const ordinary = await f.session.getRows({ limit: 1 }, new AbortController().signal);
    expect(ordinary.rows[0]?.ref.ordinal).toBe('0');
    expect(bytes).toBeGreaterThanOrEqual(originalSize);
    bytes = 0;
    await expect(f.session.getGraphRows(new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(bytes).toBe(0);
  });

  it.each([
    { direction: 'backward' as const },
    { direction: 'forward' as const, sort: { columnId: 'message', direction: 'asc' as const } },
    { direction: 'forward' as const, sortOffset: '1' },
  ])('rejects a non-physical observed query before source reads (%o)', async (options) => {
    const f = await fixture();
    const reads = vi.spyOn(f.handle, 'read');
    await expect(f.engine.getObservedBackgroundRows({
      ...options, scanBudget: { deadlineEpochMs: Date.now() + 60_000 },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(['no-LF first record', 'dense tiny LF records'])('caps all filesystem read requests at 4 MiB for %s without timing', async (shape) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const contents = shape === 'no-LF first record' ? 'x'.repeat(6 * 1024 * 1024) : '{}\n'.repeat(2_000_000);
    const f = await fixture(contents);
    const original = f.handle.read.bind(f.handle) as PositionalRead;
    let requested = 0;
    let returned = 0;
    const spy = vi.spyOn(f.handle, 'read') as unknown as { mockImplementation(read: PositionalRead): void };
    spy.mockImplementation(async (buffer, offset, length, position) => {
      requested += length;
      const result = await original(buffer, offset, length, position);
      returned += result.bytesRead;
      return result;
    });
    const result = await f.session.getGraphRows(new AbortController().signal).catch((error: unknown) => error);
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(returned).toBeLessThanOrEqual(requested);
    if (shape === 'no-LF first record') {
      expect(result).toMatchObject({ code: 'READ_BUDGET_EXCEEDED' });
      expect(requested).toBe(4 * 1024 * 1024);
    } else {
      expect(result).toMatchObject({ rows: expect.any(Array), scan: { examinedRecords: '100', truncatedReason: 'record_limit' } });
    }
  });
});
