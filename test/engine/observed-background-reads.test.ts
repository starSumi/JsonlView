import { mkdtemp, type FileHandle, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine, type JsonlEngineOptions } from '../../src/engine';
import { observedReadAllowance } from '../../src/engine/source-observation';
import { readFileHandle } from '../../src/engine/snapshot-fingerprint';

const directories: string[] = [];
const engines: JsonlFileEngine[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(contents: string, options: JsonlEngineOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-observed-reads-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.jsonl');
  await writeFile(path, contents);
  const engine = await JsonlFileEngine.open(path, { newlineScanner: 'off', ...options });
  engines.push(engine);
  const handle = (engine as unknown as { handle: FileHandle }).handle;
  return { engine, handle };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

type PositionalRead = (
  buffer: Buffer, offset: number, length: number, position: number | bigint | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

function observeReads(handle: FileHandle, read: (original: PositionalRead) => PositionalRead) {
  const original = handle.read.bind(handle) as PositionalRead;
  const spy = vi.spyOn(handle, 'read') as unknown as { mockImplementation(read: PositionalRead): void };
  spy.mockImplementation(read(original));
}

const physicalPage = { direction: 'forward' as const, limit: 100,
  projection: { conversation: false, dataset: false } };

describe('observed background read allowance', () => {
  it('shortens a cross-chunk request before reading, then releases queued foreground work', async () => {
    const f = await fixture('x'.repeat(6 * 1024 * 1024));
    const allowance = 4 * 1024 * 1024 - 137;
    const started = deferred();
    const gate = deferred();
    const lengths: number[] = [];
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      lengths.push(length);
      if (lengths.length === 1) { started.resolve(); await gate.promise; }
      return original(buffer, offset, length, position);
    });
    let settled = false;
    const page = f.engine.getObservedBackgroundRows({ ...physicalPage,
      scanBudget: { maxExaminedBytes: BigInt(allowance), deadlineEpochMs: Date.now() + 60_000 },
    }).catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await started.promise;
      const foreground = f.engine.getSchema();
      expect(settled).toBe(false); // An already active FileHandle.read is not preempted.
      gate.resolve();
      expect(await page).toMatchObject({ code: 'READ_BUDGET_EXCEEDED' });
      await expect(foreground).resolves.toHaveProperty('fields');
      expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(allowance);
      expect(lengths.at(-1)).toBe(256 * 1024 - 137);
      const resumed = await f.engine.getRows({ limit: 1 });
      expect(resumed.rows[0]?.ref).toMatchObject({ ordinal: '0', contentByteLength: String(6 * 1024 * 1024) });
    } finally {
      gate.resolve();
      await page;
    }
  });

  it('keeps the requested-byte reservation after a short read', async () => {
    const f = await fixture('x'.repeat(2 * 1024 * 1024));
    let requested = 0;
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      requested += length;
      const result = await original(buffer, offset, Math.min(1, length), position);
      return result;
    });
    await expect(f.engine.getObservedBackgroundRows({ ...physicalPage,
      scanBudget: { maxExaminedBytes: '300000', deadlineEpochMs: Date.now() + 60_000 },
    })).rejects.toMatchObject({ code: 'READ_BUDGET_EXCEEDED' });
    expect(requested).toBe(300_000);
  });

  it('keeps the reservation after a failed read without refunding it', async () => {
    const f = await fixture('x'.repeat(1_000));
    const lengths: number[] = [];
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      lengths.push(length);
      if (lengths.length === 1) throw new Error('injected read failure');
      return original(buffer, offset, length, position);
    });
    const precharged: number[] = [];
    const allowance = observedReadAllowance({ scanBudget: { maxExaminedBytes: '150' }, onObservedReadRequest: (bytes) => { precharged.push(bytes); } }, () => {});
    const buffer = Buffer.alloc(100);
    await expect(readFileHandle(f.handle, buffer, 0, 100, 0, allowance)).rejects.toThrow('injected read failure');
    await expect(readFileHandle(f.handle, buffer, 0, 100, 0, allowance)).resolves.toBe(50);
    await expect(readFileHandle(f.handle, buffer, 0, 100, 0, allowance)).rejects.toMatchObject({ code: 'READ_BUDGET_EXCEEDED' });
    expect(lengths).toEqual([100, 50]);
    expect(precharged).toEqual([100, 50]);
  });

  it('gives cancellation precedence at exhaustion and continues foreground work', async () => {
    const f = await fixture('x'.repeat(2 * 1024 * 1024));
    const controller = new AbortController();
    let requested = 0;
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      requested += length;
      const result = await original(buffer, offset, length, position);
      controller.abort();
      return result;
    });
    await expect(f.engine.getObservedBackgroundRows({ ...physicalPage, signal: controller.signal,
      scanBudget: { maxExaminedBytes: '123', deadlineEpochMs: Date.now() + 60_000 },
    })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(requested).toBe(123);
    await expect(f.engine.getSchema()).resolves.toHaveProperty('fields');
  });

  it('shares one allowance between cold indexing and row hydration', async () => {
    const source = '{"message":"' + 'x'.repeat(600_000) + '"}\n';
    const f = await fixture(source.repeat(3));
    let requested = 0;
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      requested += length;
      return original(buffer, offset, length, position);
    });
    await expect(f.engine.getObservedBackgroundRows({ ...physicalPage,
      scanBudget: { maxExaminedRecords: 1, maxExaminedBytes: '900000', deadlineEpochMs: Date.now() + 60_000 },
    })).rejects.toMatchObject({ code: 'READ_BUDGET_EXCEEDED' });
    expect(requested).toBe(900_000);
    // Index-only work could fit, but hydration must spend the same allowance.
    expect(BigInt(f.engine.getSummary().indexedRecords)).toBeGreaterThan(0n);
  });

  it('shares one allowance between an evicted exact-ref segment and row hydration', async () => {
    const source = '{"message":"' + 'x'.repeat(600_000) + '"}\n';
    const f = await fixture(source.repeat(3), { segmentTargetRecords: 1, exactCacheSegments: 1 });
    await f.engine.finishIndexing();
    expect(f.engine.getDiagnostics()).toMatchObject({ segmentCount: 3, exactCachedSegments: 1, complete: true });
    let requested = 0;
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      requested += length;
      return original(buffer, offset, length, position);
    });
    await expect(f.engine.getObservedBackgroundRows({ ...physicalPage,
      scanBudget: { maxExaminedRecords: 1, maxExaminedBytes: '900000', deadlineEpochMs: Date.now() + 60_000 },
    })).rejects.toMatchObject({ code: 'READ_BUDGET_EXCEEDED' });
    expect(requested).toBe(900_000);
  });

  it.each(['deadline', 'abort'] as const)('checks %s after an active read settles without starting another read', async (stop) => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = await fixture('x'.repeat(6 * 1024 * 1024));
    const started = deferred(); const gate = deferred();
    const controller = new AbortController();
    const lengths: number[] = [];
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      lengths.push(length); started.resolve(); await gate.promise;
      return original(buffer, offset, length, position);
    });
    let settled = false;
    const result = f.engine.getObservedBackgroundRows({ ...physicalPage, signal: controller.signal,
      scanBudget: { maxExaminedBytes: '4194304', deadlineEpochMs: 1_500 },
    }).catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await started.promise;
      if (stop === 'deadline') now = 2_000;
      else controller.abort();
      expect(settled).toBe(false);
      gate.resolve();
      expect(await result).toMatchObject({ code: 'ABORTED' });
      expect(lengths).toEqual([256 * 1024]);
      await expect(f.engine.getSchema()).resolves.toHaveProperty('fields');
    } finally { gate.resolve(); await result; }
  });

  it('keeps foreground FIFO ahead of queued observed pages after demand drains', async () => {
    const f = await fixture('{}\n'.repeat(100));
    const started = deferred(); const gate = deferred();
    let first = true;
    observeReads(f.handle, (original) => async (buffer, offset, length, position) => {
      if (first) { first = false; started.resolve(); await gate.promise; }
      return original(buffer, offset, length, position);
    });
    const active = f.engine.getRows({ limit: 1 });
    const order: string[] = [];
    try {
      await started.promise;
      const background = f.engine.getObservedBackgroundRows({ ...physicalPage,
        scanBudget: { maxExaminedRecords: 100, maxExaminedBytes: '4194304', deadlineEpochMs: Date.now() + 60_000 },
      }).then(() => order.push('background'));
      const firstForeground = f.engine.getSchema().then(() => order.push('foreground-1'));
      const secondForeground = f.engine.getRows({ limit: 1 }).then(() => order.push('foreground-2'));
      gate.resolve();
      await Promise.all([active, background, firstForeground, secondForeground]);
      expect(order).toEqual(['foreground-1', 'foreground-2', 'background']);
    } finally {
      gate.resolve(); await active;
    }
  });
});
