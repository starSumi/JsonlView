import { appendFile, mkdtemp, open, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JsonlEngineError,
  JsonlFileEngine,
  evaluatePredicate,
} from '../../src/engine';
import { keyPath, MAX_TABLE_COLUMNS, type ColumnSpec, type Predicate, type RowSort } from '../../src/shared/types';
import { AdaptiveSegmentIndex, type InternalRecordRef } from '../../src/engine/segment-index';
import { createNewlineScanner } from '../../src/engine/newline-scanner';
import * as sourceReads from '../../src/engine/snapshot-fingerprint';
import type { JsonlQueryTiming } from '../../src/engine/jsonl-engine-types';

const temporaryDirectories: string[] = [];
const engines: JsonlFileEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map(async (engine) => engine.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function fixture(contents: string | Uint8Array, options: Parameters<typeof JsonlFileEngine.open>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-engine-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'fixture.jsonl');
  await writeFile(path, contents);
  const engine = await JsonlFileEngine.open(path, options);
  engines.push(engine);
  return { engine, path };
}

type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | bigint | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

interface PositionalReadSpy {
  mock: { calls: Array<[Buffer, number, number, number | bigint | null]> };
  mockImplementation(implementation: PositionalRead): this;
  mockRestore(): void;
}

function spyOnPositionalReads(engine: JsonlFileEngine): PositionalReadSpy {
  const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
  return vi.spyOn(handle, 'read') as unknown as PositionalReadSpy;
}

describe('JsonlFileEngine indexing and hydration', () => {
  it('validates observed source metadata with zero content reads before and after an append', async () => {
    const { engine, path } = await fixture('{"value":"' + 'x'.repeat(2 * 1024 * 1024) + '"}\n');
    const reads = spyOnPositionalReads(engine);
    expect(await engine.validateObservedSource()).toBe(true);
    expect(reads.mock.calls).toHaveLength(0);
    await appendFile(path, '{}\n');
    expect(await engine.validateObservedSource()).toBe(false);
    expect(reads.mock.calls).toHaveLength(0);
    reads.mockRestore();
  });
  it('rejects same-length observed rewrites, missing paths and cancelled source observations', async () => {
    const { engine, path } = await fixture('{"a":1}\n');
    const originalTime = engine.snapshot.mtimeMs;
    await writeFile(path, '{"a":2}\n');
    await utimes(path, new Date(originalTime + 2000), new Date(originalTime + 2000));
    expect(await engine.validateObservedSource()).toBe(false);
    const controller = new AbortController(); controller.abort();
    expect(await engine.validateObservedSource({ signal: controller.signal })).toBe(false);
    if (process.platform !== 'win32') {
      await rm(path);
      expect(await engine.validateObservedSource()).toBe(false);
    }
  });
  it('serializes byte coordinates above Number.MAX_SAFE_INTEGER without precision loss', () => {
    const hugeStart = BigInt(Number.MAX_SAFE_INTEGER) + 123_456_789n;
    const ref: InternalRecordRef = {
      ordinal: hugeStart + 1n,
      byteStart: hugeStart,
      byteEndExclusive: hugeStart + 17n,
      contentByteLength: 17n,
      delimiterByteLength: 1,
      parseState: 'unknown',
    };
    const unusedHandle = {} as ConstructorParameters<typeof AdaptiveSegmentIndex>[0];
    const index = new AdaptiveSegmentIndex(unusedHandle, 0n, {
      readChunkBytes: 4,
      segmentTargetBytes: 16,
      segmentTargetRecords: 2,
      exactCacheSegments: 1,
      maxRecordBytes: 1024,
      newlineScanner: createNewlineScanner({ mode: 'node' }),
      validateSnapshot: async () => undefined,
    });

    expect(index.toPublic(ref, 'generation')).toMatchObject({
      ordinal: (hugeStart + 1n).toString(),
      byteStart: hugeStart.toString(),
      byteEndExclusive: (hugeStart + 17n).toString(),
      contentByteLength: '17',
    });
  });

  it('does not commit staged offsets when the async snapshot validation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-staged-index-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'fixture.jsonl');
    await writeFile(path, '{"a":1}\n{"a":2}\n');
    const handle = await open(path, 'r');
    const index = new AdaptiveSegmentIndex(handle, 16n, {
      readChunkBytes: 256 * 1024,
      segmentTargetBytes: 1024,
      segmentTargetRecords: 16,
      exactCacheSegments: 1,
      maxRecordBytes: 1024,
      newlineScanner: createNewlineScanner({ mode: 'node' }),
      validateSnapshot: async () => {
        throw new JsonlEngineError('SOURCE_CHANGED', 'test snapshot invalidation');
      },
    });

    try {
      await expect(index.indexMore(256 * 1024, () => undefined)).rejects.toMatchObject({
        code: 'SOURCE_CHANGED',
      });
      expect(index.diagnostics()).toMatchObject({ indexedBytes: '0', indexedRecords: '0' });
    } finally {
      await handle.close();
    }
  });

  it('does not read past an explicit incremental index byte budget', async () => {
    const { engine } = await fixture('{"a":1}\n{"a":2}\n', { readChunkBytes: 64 });

    const summary = await engine.indexMore({ maxBytes: 1 });

    expect(summary.indexedBytes).toBe('1');
    expect(summary.indexingComplete).toBe(false);
  });

  it.each(['é', '你', '😀'].flatMap((character) =>
    Array.from({ length: Buffer.byteLength(character) - 1 }, (_, index) => ({
      character,
      splitAfterBytes: index + 1,
    }))))('preserves UTF-8 $character split after byte $splitAfterBytes across read chunks', async ({ character, splitAfterBytes }) => {
    const prefix = '{"value":"';
    const values = [{ value: character, other: true }, { value: character, last: true }];
    const records = values.map((value) => JSON.stringify(value));
    const source = records.join('\r\n');
    const readChunkBytes = Buffer.byteLength(prefix) + splitAfterBytes;
    // The first indexing read ends inside the selected two-, three-, or four-byte code point.
    expect(Buffer.from(source).subarray(0, readChunkBytes).toString('utf8')).toContain('\uFFFD');
    const { engine } = await fixture(source, { readChunkBytes, newlineScanner: 'off' });

    const page = await engine.getRows({ limit: 10 });

    expect(page.rows.map(({ ref }) => ({ ordinal: ref.ordinal, byteStart: ref.byteStart,
      byteEndExclusive: ref.byteEndExclusive, delimiterByteLength: ref.delimiterByteLength,
      contentByteLength: ref.contentByteLength, parseState: ref.parseState }))).toEqual([
      { ordinal: '0', byteStart: '0', byteEndExclusive: String(Buffer.byteLength(records[0]!)),
        delimiterByteLength: 2, contentByteLength: String(Buffer.byteLength(records[0]!)), parseState: 'valid' },
      { ordinal: '1', byteStart: String(Buffer.byteLength(records[0]!) + 2), byteEndExclusive: String(Buffer.byteLength(source)),
        delimiterByteLength: 0, contentByteLength: String(Buffer.byteLength(records[1]!)), parseState: 'valid' },
    ]);
    for (const [index, row] of page.rows.entries()) {
      const detail = await engine.getDetail(row.ref);
      expect(detail.value).toEqual(values[index]);
      expect(detail.rawPreview).toBe(records[index]);
      expect(detail.rawComplete).toBe(true);
    }
    expect(page.totalRecords).toBe('2');
  });

  it('handles BOM, boundary-spanning CRLF, LF, and a final line without a delimiter', async () => {
    const { engine } = await fixture('\uFEFF{"a":1}\r\n{"a":2}\n{"a":3}', {
      readChunkBytes: 11,
      segmentTargetRecords: 2,
    });

    const page = await engine.getRows({ limit: 10 });

    expect(page.rows).toHaveLength(3);
    expect(page.rows.map((row) => row.ref.parseState)).toEqual(['valid', 'valid', 'valid']);
    expect(page.rows.map((row) => row.ref.delimiterByteLength)).toEqual([2, 1, 0]);
    expect(page.rows.map((row) => [row.ref.byteStart, row.ref.byteEndExclusive])).toEqual([
      ['0', '10'],
      ['12', '19'],
      ['20', '27'],
    ]);
    expect(page.rows.map((row) => row.genericSummary)).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
    expect(page.rows[0]?.problems).toEqual([
      expect.objectContaining({ code: 'NON_STANDARD_BOM', severity: 'warning' }),
    ]);
    expect(page.totalRecords).toBe('3');

    const schema = await engine.getSchema();
    expect(schema.complete).toBe(true);
    expect(schema.fields.find((field) => field.displayPath === '$.a')).toMatchObject({
      seenRecords: '3',
      validRecordsObserved: '3',
      missingRecords: '0',
      kinds: { integer: '3' },
      confidence: 'complete',
    });
  });

  it('reports opt-in phase timings without changing rows or allowing observer failures to escape', async () => {
    const { engine } = await fixture('{"id":1,"value":"sample"}\n{"id":2,"value":"next"}');
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const originalRead = handle.read.bind(handle) as PositionalRead;
    const reads = spyOnPositionalReads(engine);
    reads.mockImplementation(async (buffer, offset, length, position) => {
      const result = await originalRead(buffer, offset, length, position);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return result;
    });
    const originalParse = JSON.parse;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      const until = performance.now() + 6;
      while (performance.now() < until) { /* Make the parse span observable in this focused test. */ }
      return originalParse(text);
    });
    let observed: { queueWaitMs: number; queueBlockedBy: string; readWaitMs: number; parseMs: number } | undefined;

    let page: Awaited<ReturnType<typeof engine.getRows>>;
    try {
      page = await engine.getRows({
        limit: 1,
        onTiming: (timing) => {
          observed = timing;
          throw new Error('diagnostic observer failure');
        },
      });
    } finally {
      parse.mockRestore();
    }

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.genericSummary).toBe('{"id":1,"value":"sample"}');
    expect(observed).toEqual(expect.objectContaining({ queueBlockedBy: 'none' }));
    expect(observed?.readWaitMs).toBeGreaterThan(0);
    expect(observed?.parseMs).toBeGreaterThanOrEqual(6);
    expect(Object.values(observed ?? {}).filter((value) => typeof value === 'number')
      .every((value) => Number.isSafeInteger(value) && value >= 0)).toBe(true);
  });

  it('reports queue wait and engine execution as separate spans', async () => {
    const { engine } = await fixture('{"id":1}');
    let clock = 0;
    const timestamps: number[] = [];
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 10;
      timestamps.push(clock);
      return clock;
    });
    let observed: { queueWaitMs: number; engineExecMs: number } | undefined;

    try {
      await engine.getRows({ limit: 1, onTiming: (timing) => { observed = timing; } });
    } finally {
      now.mockRestore();
    }

    const enqueuedAt = timestamps[0];
    const startedAt = timestamps[1];
    const finishedAt = timestamps.at(-1);
    expect(enqueuedAt).toBeDefined();
    expect(startedAt).toBeDefined();
    expect(finishedAt).toBeDefined();
    expect(observed).toMatchObject({
      queueWaitMs: startedAt! - enqueuedAt!,
      engineExecMs: finishedAt! - startedAt!,
    });
    expect(observed?.queueWaitMs).not.toBe(observed?.engineExecMs);
  });

  it.each(['one-slow', 'many-fast'] as const)('distinguishes %s reads from read amplification', async (shape) => {
    const { engine } = await fixture('{"id":1}\n{"id":2}\n{"id":3}', { readChunkBytes: 4 });
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const originalRead = handle.read.bind(handle) as PositionalRead;
    const reads = spyOnPositionalReads(engine);
    let clock = 0;
    let calls = 0;
    let bytes = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    reads.mockImplementation(async (buffer, offset, length, position) => {
      const result = await originalRead(buffer, offset, length, position);
      clock += shape === 'one-slow' ? (calls === 0 ? 50 : 0) : 1;
      calls += 1;
      bytes += result.bytesRead;
      return result;
    });
    let observed: JsonlQueryTiming | undefined;
    try {
      await engine.getRows({ limit: 3, onTiming: (timing) => { observed = timing; } });
    } finally {
      now.mockRestore();
      reads.mockRestore();
    }
    expect(calls).toBeGreaterThan(1);
    expect(observed).toMatchObject({ readCalls: calls, readBytes: bytes,
      readWaitMs: shape === 'one-slow' ? 50 : calls, readMaxWaitMs: shape === 'one-slow' ? 50 : 1 });
  });

  it('includes a failed read attempt in timing and preserves the original read failure', async () => {
    const { engine } = await fixture('{"id":1}');
    const failure = new Error('read failed');
    const reads = spyOnPositionalReads(engine);
    reads.mockImplementation(async () => { throw failure; });
    let observed: { readCalls: number; readBytes: number; readMaxWaitMs: number } | undefined;
    try {
      await expect(engine.getRows({ onTiming: (timing) => { observed = timing; } })).rejects.toBe(failure);
    } finally {
      reads.mockRestore();
    }
    expect(observed).toMatchObject({ readCalls: 1, readBytes: 0 });
    expect(Number.isSafeInteger(observed?.readMaxWaitMs)).toBe(true);
  });

  it('saturates read-byte and per-read timing diagnostics without changing returned data', async () => {
    const { engine } = await fixture('{"id":1}');
    const originalRead = sourceReads.readFileHandle;
    const reads = vi.spyOn(sourceReads, 'readFileHandle').mockImplementation(async (handle, buffer, offset, length, position, observer) => {
      const result = await originalRead(handle, buffer, offset, length, position);
      observer?.(Number.MAX_SAFE_INTEGER * 2, Number.MAX_SAFE_INTEGER);
      return result;
    });
    let observed: { readCalls: number; readBytes: number; readMaxWaitMs: number; readWaitMs: number } | undefined;
    try {
      const page = await engine.getRows({ onTiming: (timing) => { observed = timing; } });
      expect(page.rows).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
    expect(observed).toMatchObject({ readBytes: Number.MAX_SAFE_INTEGER,
      readMaxWaitMs: Number.MAX_SAFE_INTEGER, readWaitMs: Number.MAX_SAFE_INTEGER });
    expect(observed?.readCalls).toBeGreaterThan(1);
  });

  it('attributes queue wait to the immediately preceding FIFO operation', async () => {
    const { engine } = await fixture('{"id":1}\n{"id":2}', { readChunkBytes: 64 });
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const originalRead = handle.read.bind(handle) as PositionalRead;
    const reads = spyOnPositionalReads(engine);
    let notifyReadStarted!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    reads.mockImplementation(async (buffer, offset, length, position) => {
      notifyReadStarted();
      await readGate;
      return originalRead(buffer, offset, length, position);
    });

    const indexing = engine.indexMore({ maxBytes: 64 });
    await readStarted;
    const schema = engine.getSchema();
    let observed: { queueWaitMs: number; queueBlockedBy: string } | undefined;
    const querying = engine.getRows({ limit: 1, onTiming: (timing) => { observed = timing; } });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      releaseRead();
    }
    await Promise.all([indexing, schema, querying]);

    expect(observed).toEqual(expect.objectContaining({ queueBlockedBy: 'get_schema' }));
    expect(observed?.queueWaitMs).toBeGreaterThan(0);
  });

  it('coalesces eligible forward-page reads without changing physical row semantics', async () => {
    const records = Array.from({ length: 120 }, (_, ordinal) => {
      if (ordinal === 0) return Buffer.from('\uFEFF{"id":0}');
      if (ordinal === 1) return Buffer.from('   ');
      if (ordinal === 2) return Buffer.from('{bad}');
      if (ordinal === 3) return Buffer.from([0xff]);
      return Buffer.from(JSON.stringify({ id: ordinal, value: 'x'.repeat(20) }));
    });
    const contents = Buffer.concat(records.flatMap((record, ordinal) => [
      record,
      ...(ordinal === records.length - 1 ? [] : [Buffer.from(ordinal === 0 ? '\r\n' : '\n')]),
    ]));
    const { engine } = await fixture(contents);
    await engine.finishIndexing();
    const reads = spyOnPositionalReads(engine);

    const firstPage = await engine.getRows({ limit: 100 });
    const firstPageReadCalls = reads.mock.calls.length;

    expect(firstPageReadCalls).toBe(1);
    expect(firstPage.rows).toHaveLength(100);
    expect(firstPage.rows.map(({ ref }) => ref.ordinal)).toEqual(
      Array.from({ length: 100 }, (_, ordinal) => String(ordinal)),
    );
    expect(firstPage.rows.slice(0, 4).map(({ ref, problems }) => [
      ref.parseState, ref.delimiterByteLength, problems?.map(({ code }) => code) ?? [],
    ])).toEqual([
      ['valid', 2, ['NON_STANDARD_BOM']],
      ['blank', 1, ['BLANK_RECORD']],
      ['invalid_json', 1, ['INVALID_JSON']],
      ['encoding_error', 1, ['INVALID_UTF8']],
    ]);
    expect(firstPage.rows[0]?.genericSummary).toBe('{"id":0}');
    expect(firstPage.rows[99]?.genericSummary).toContain('"id":99');
    expect(firstPage.anchorOrdinal).toBe('99');
    expect(firstPage.hasAfter).toBe(true);
    expect(engine.getDiagnostics().observedSchemaRecords).toBe('101');

    const secondPage = await engine.getRows({ anchorOrdinal: firstPage.anchorOrdinal, limit: 100 });

    expect(secondPage.rows.map(({ ref }) => ref.ordinal)).toEqual(
      Array.from({ length: 20 }, (_, ordinal) => String(ordinal + 100)),
    );
    expect(secondPage.rows.at(-1)?.ref.delimiterByteLength).toBe(0);
    expect(secondPage.hasAfter).toBe(false);
  });

  it('returns the default first page before the full index completes and resumes after its visible boundary', async () => {
    const source = Array.from({ length: 500 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const stats = vi.spyOn(handle, 'stat');

    const firstPage = await engine.getRows({ limit: 100 });

    expect(firstPage.rows.map(({ ref }) => ref.ordinal)).toEqual(
      Array.from({ length: 100 }, (_, ordinal) => String(ordinal)),
    );
    expect(firstPage.anchorOrdinal).toBe('99');
    expect(firstPage.hasAfter).toBe(true);
    expect(engine.getSummary()).toMatchObject({ indexedRecords: '101', indexingComplete: false });
    expect(stats.mock.calls.length).toBeLessThanOrEqual(4);

    const secondPage = await engine.getRows({ anchorOrdinal: firstPage.anchorOrdinal, limit: 100 });

    expect(secondPage.rows.map(({ ref }) => ref.ordinal)).toEqual(
      Array.from({ length: 100 }, (_, ordinal) => String(ordinal + 100)),
    );
  });

  it('matches direct hydration across read-window refills and a row boundary', async () => {
    const source = Array.from({ length: 120 }, (_, id) => JSON.stringify({
      id,
      payload: 'x'.repeat(id === 0 ? 15 * 1024 : 512),
    })).join('\n');
    const generation = 'forward-window-parity';
    const { engine: windowEngine } = await fixture(source, { generation });
    const { engine: directEngine } = await fixture(source, { generation });
    await Promise.all([windowEngine.finishIndexing(), directEngine.finishIndexing()]);
    const windowReads = spyOnPositionalReads(windowEngine);
    const directReads = spyOnPositionalReads(directEngine);
    const observedOrdinals: string[] = [];

    const windowPage = await windowEngine.getRows({ limit: 100 });
    const directPage = await directEngine.getRows({
      limit: 100,
      onHydrated: ({ ref }) => observedOrdinals.push(ref.ordinal),
    });

    expect(windowPage).toEqual(directPage);
    expect(observedOrdinals).toEqual(Array.from({ length: 101 }, (_, id) => String(id)));
    expect(windowReads.mock.calls.length).toBeLessThan(directReads.mock.calls.length);
    expect(windowEngine.getDiagnostics().observedSchemaRecords)
      .toBe(directEngine.getDiagnostics().observedSchemaRecords);
  });

  it('avoids read-ahead when one physical record exceeds half a window', async () => {
    const records = Array.from({ length: 120 }, (_, id) => JSON.stringify({
      id,
      payload: 'x'.repeat(9 * 1024),
    }));
    const source = records.join('\n');
    const { engine } = await fixture(source);
    await engine.finishIndexing();
    const reads = spyOnPositionalReads(engine);

    const page = await engine.getRows({ limit: 100 });

    expect(page.rows).toHaveLength(100);
    expect(reads.mock.calls).toHaveLength(101);
    expect(reads.mock.calls.every(([, , length]) => length < 16 * 1024)).toBe(true);
  });

  it('does not read ahead when hydration callbacks observe each record', async () => {
    const source = Array.from({ length: 110 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);
    await engine.finishIndexing();
    const reads = spyOnPositionalReads(engine);
    const observed: string[] = [];

    await engine.getRows({ limit: 100, onHydrated: ({ ref }) => observed.push(ref.ordinal) });

    expect(observed).toHaveLength(101);
    expect(reads.mock.calls.length).toBe(101);
  });

  it('keeps smaller forward pages on direct reads', async () => {
    const source = Array.from({ length: 40 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);
    await engine.finishIndexing();
    const reads = spyOnPositionalReads(engine);

    await engine.getRows({ limit: 20 });

    expect(reads.mock.calls.length).toBe(21);
  });

  it('keeps configured small read chunks on the direct hydration path', async () => {
    const source = Array.from({ length: 120 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 8 });
    await engine.finishIndexing();
    const reads = spyOnPositionalReads(engine);

    await engine.getRows({ limit: 100 });

    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(101);
    expect(reads.mock.calls.every(([, , length]) => length <= 8)).toBe(true);
  });

  it('preserves row parsing when positional reads return short buffers', async () => {
    const source = Array.from({ length: 240 }, (_, id) => String(id)).join('\n');
    const { engine } = await fixture(source);
    await engine.finishIndexing();
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const originalRead = handle.read.bind(handle) as PositionalRead;
    const reads = spyOnPositionalReads(engine);
    reads.mockImplementation((buffer, offset, length, position) => (
      originalRead(buffer, offset, Math.min(length, 7), position)
    ));

    const page = await engine.getRows({ limit: 100 });

    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(page.rows.map(({ genericSummary }) => genericSummary)).toEqual(
      Array.from({ length: 100 }, (_, id) => String(id)),
    );
    expect(page.hasAfter).toBe(true);
  });

  it('falls back to direct reads for records larger than the bounded window', async () => {
    const records = [JSON.stringify({ id: 0, payload: 'x'.repeat(20 * 1024) })];
    records.push(...Array.from({ length: 110 }, (_, index) => JSON.stringify({ id: index + 1 })));
    const { engine } = await fixture(records.join('\n'));
    await engine.finishIndexing();
    const reads = spyOnPositionalReads(engine);

    const page = await engine.getRows({ limit: 100 });

    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]?.ref.parseState).toBe('valid');
    expect(page.rows[0]?.ref.contentByteLength).toBe(String(Buffer.byteLength(records[0] ?? '')));
    expect(page.rows[99]?.ref.ordinal).toBe('99');
    expect(reads.mock.calls.length).toBeLessThan(101);
  });

  it('checks cancellation immediately after filling a forward read window', async () => {
    const source = Array.from({ length: 600 }, (_, id) => JSON.stringify({ id, value: 'x'.repeat(32) })).join('\n');
    const { engine } = await fixture(source);
    await engine.finishIndexing();
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const originalRead = handle.read.bind(handle) as PositionalRead;
    const controller = new AbortController();
    const reads = spyOnPositionalReads(engine);
    reads.mockImplementation(async (buffer, offset, length, position) => {
      const result = await originalRead(buffer, offset, length, position);
      controller.abort();
      return result;
    });

    await expect(engine.getRows({ limit: 100, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });

    expect(reads.mock.calls[0]?.[2]).toBe(16 * 1024);
    expect(engine.getDiagnostics().observedSchemaRecords).toBe('0');
  });

  it('rejects a page when the source is truncated during a window fill', async () => {
    const source = Array.from({ length: 600 }, (_, id) => JSON.stringify({ id, value: 'x'.repeat(32) })).join('\n');
    const { engine, path } = await fixture(source);
    await engine.finishIndexing();
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const originalRead = handle.read.bind(handle) as PositionalRead;
    const reads = spyOnPositionalReads(engine);
    reads.mockImplementation(async (buffer, offset, length, position) => {
      const result = await originalRead(buffer, offset, length, position);
      await truncate(path, 8);
      return result;
    });

    await expect(engine.getRows({ limit: 100 })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('does not hydrate read-ahead bytes beyond the page hydration budget', async () => {
    const source = Array.from({ length: 120 }, (_, id) => JSON.stringify({ id, value: 'x'.repeat(12) })).join('\n');
    const { engine } = await fixture(source, { pageHydrationMaxBytes: 120 });
    await engine.finishIndexing();

    const page = await engine.getRows({ limit: 100 });

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.length).toBeLessThan(100);
    expect(page.scan?.truncatedReason).toBe('hydration_limit');
    expect(engine.getDiagnostics().observedSchemaRecords).toBe(String(page.scan?.examinedRecords));
  });

  it('keeps oversized records on preview-only reads in forward pages', async () => {
    const { engine } = await fixture(JSON.stringify({ payload: 'x'.repeat(32 * 1024) }), {
      maxRecordBytes: 128,
      previewBytes: 12,
    });
    await engine.finishIndexing();
    const reads = spyOnPositionalReads(engine);

    const page = await engine.getRows({ limit: 100 });

    expect(page.rows[0]?.ref.parseState).toBe('oversized');
    expect(reads.mock.calls).toHaveLength(1);
    expect(reads.mock.calls[0]?.[2]).toBe(12);
  });

  it('clamps forward read-ahead to the opened snapshot when the file is appended', async () => {
    const source = Array.from({ length: 120 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine, path } = await fixture(source);
    await engine.finishIndexing();
    const originalSize = BigInt(Buffer.byteLength(source));
    await appendFile(path, '\n' + JSON.stringify({ id: 120 }));
    const reads = spyOnPositionalReads(engine);

    const page = await engine.getRows({ limit: 100 });

    expect(page.rows).toHaveLength(100);
    expect(page.rows.at(-1)?.ref.ordinal).toBe('99');
    expect(page.hasAfter).toBe(true);
    for (const [, , requestedLength, position] of reads.mock.calls) {
      if (typeof position === 'number' || typeof position === 'bigint') {
        expect(BigInt(position) + BigInt(requestedLength ?? 0)).toBeLessThanOrEqual(originalSize);
      }
    }
  });

  it('preserves blank, malformed JSON, malformed UTF-8, and scalar records', async () => {
    const bytes = Buffer.concat([
      Buffer.from('\n{bad}\n42\n"ok"\n'),
      Buffer.from([0xff, 0x0a]),
      Buffer.from('null'),
    ]);
    const { engine } = await fixture(bytes, { readChunkBytes: 4 });

    const page = await engine.getRows({
      limit: 20,
      columns: [{ id: 'summary', label: 'Summary', source: 'profile' }],
    });

    expect(page.rows.map((row) => row.ref.parseState)).toEqual([
      'blank',
      'invalid_json',
      'valid',
      'valid',
      'encoding_error',
      'valid',
    ]);
    expect(page.rows[0]?.problems?.[0]?.code).toBe('BLANK_RECORD');
    expect(page.rows[1]?.problems?.[0]?.code).toBe('INVALID_JSON');
    expect(page.rows[0]?.cells).toContainEqual(expect.objectContaining({
      columnId: 'summary',
      value: '[blank record]',
    }));
    expect(page.rows[1]?.cells).toContainEqual(expect.objectContaining({
      columnId: 'summary',
      value: expect.stringContaining('[invalid JSON]'),
    }));
    expect(page.rows[4]?.problems?.[0]?.code).toBe('INVALID_UTF8');
    expect(page.rows[2]?.kind).toBe('integer');
    expect(page.rows[3]?.kind).toBe('string');
    expect(page.rows[5]?.kind).toBe('null');
    expect(engine.getSummary()).toMatchObject({ validRecords: '3', problemRecords: '3' });
  });

  it('scans problem entries independently with bounded completion metadata', async () => {
    const { engine } = await fixture('\n{bad}\n{"ok":true}\n');

    const partial = await engine.getProblems({
      limit: 10,
      scanBudget: { maxExaminedRecords: 1 },
    });
    expect(partial.items.map((problem) => problem.code)).toEqual(['BLANK_RECORD']);
    expect(partial.complete).toBe(false);
    expect(partial.scan.truncatedReason).toBe('record_limit');
    expect(partial.hasAfter).toBe(true);

    const complete = await engine.getProblems({ limit: 10 });
    expect(complete.items.map((problem) => problem.code)).toEqual(['BLANK_RECORD', 'INVALID_JSON']);
    expect(complete.complete).toBe(true);
    expect(complete.observedProblemRecords).toBe('2');
  });

  it('resumes problem scans from the last examined physical record, not the last problem', async () => {
    const { engine } = await fixture('{"ok":0}\n{bad}\n{"ok":2}\n\n{"ok":4}\n');

    const first = await engine.getProblems({ limit: 1 });
    expect(first.items.map((problem) => problem.code)).toEqual(['INVALID_JSON']);
    expect(first.anchorOrdinal).toBe('1');
    expect(first.scan.cursorOrdinal).toBe('1');
    expect(first.complete).toBe(false);
    expect(first.hasAfter).toBe(true);

    const next = await engine.getProblems({
      anchorOrdinal: first.anchorOrdinal,
      direction: 'forward',
      limit: 1,
    });
    expect(next.items.map((problem) => problem.code)).toEqual(['BLANK_RECORD']);
    expect(next.anchorOrdinal).toBe('3');
    expect(next.hasBefore).toBe(true);
  });

  it('does not probe beyond a backward scan budget and exposes a physical continuation', async () => {
    const { engine } = await fixture('{"ok":0}\n\n{bad}\n{"ok":3}\n');

    const page = await engine.getProblems({
      direction: 'backward',
      limit: 1,
      scanBudget: { maxExaminedRecords: 1 },
    });
    expect(page.scan.examinedRecords).toBe('1');
    expect(page.scan.truncatedReason).toBe('record_limit');
    expect(page.scan.direction).toBe('backward');
    expect(page.hasBefore).toBe(true);
  });

  it('returns a bounded placeholder and detail for an oversized physical record', async () => {
    const large = JSON.stringify({ payload: 'x'.repeat(100) });
    const { engine } = await fixture(`${large}\n{"ok":true}`, {
      maxRecordBytes: 32,
      previewBytes: 12,
      readChunkBytes: 8,
    });

    const page = await engine.getRows({ limit: 10 });
    const oversized = page.rows[0];
    expect(oversized?.ref.parseState).toBe('oversized');
    expect(oversized?.genericSummary).toContain('[oversized');
    expect(oversized?.problems?.[0]?.code).toBe('OVERSIZED_RECORD');

    const detail = await engine.getDetail(oversized!.ref);
    expect(detail.rawComplete).toBe(false);
    expect(Buffer.byteLength(detail.rawPreview)).toBeLessThanOrEqual(12);
    expect(detail.value).toBeUndefined();
    expect(page.rows[1]?.ref.parseState).toBe('valid');
  });

  it('hydrates an oversized record only after an explicit full request within its separate budget', async () => {
    const large = JSON.stringify({ payload: 'x'.repeat(100) });
    const { engine } = await fixture(`${large}\n{"ok":true}`, {
      maxRecordBytes: 32,
      fullRecordMaxBytes: 512,
      previewBytes: 12,
      readChunkBytes: 8,
    });

    const page = await engine.getRows({ limit: 2 });
    const ref = page.rows[0]!.ref;
    const preview = await engine.getDetail(ref);
    expect(preview.rawComplete).toBe(false);
    expect(preview.value).toBeUndefined();

    const full = await engine.getDetail(ref, { full: true });
    expect(full.rawComplete).toBe(true);
    expect(full.value).toEqual({ payload: 'x'.repeat(100) });
    expect(full.problems).toEqual([]);
  });

  it('keeps explicit full hydration bounded when a record exceeds the detail budget', async () => {
    const large = JSON.stringify({ payload: 'x'.repeat(100) });
    const { engine } = await fixture(large, {
      maxRecordBytes: 32,
      fullRecordMaxBytes: 64,
      previewBytes: 12,
    });
    const page = await engine.getRows({ limit: 1 });
    const full = await engine.getDetail(page.rows[0]!.ref, { full: true });
    expect(full.rawComplete).toBe(false);
    expect(full.value).toBeUndefined();
    expect(full.problems[0]?.message).toContain('explicit detail hydration');
  });

  it('keeps exact refs in a bounded segment cache instead of one object per file record', async () => {
    const source = Array.from({ length: 100 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, {
      readChunkBytes: 32,
      segmentTargetRecords: 10,
      exactCacheSegments: 2,
    });

    await engine.finishIndexing();
    expect(engine.getDiagnostics()).toMatchObject({
      segmentCount: 10,
      exactCachedSegments: 2,
      pendingExactRecords: 0,
      indexedRecords: '100',
      complete: true,
    });

    await engine.getRows({ anchorOrdinal: '69', limit: 2 });
    await engine.getRows({ anchorOrdinal: '9', limit: 2 });
    expect(engine.getDiagnostics().exactCachedSegments).toBeLessThanOrEqual(2);
  });

  it('caps retained page hydration bytes while still making cursor progress', async () => {
    const source = [
      { value: 'a'.repeat(40) },
      { value: 'b'.repeat(40) },
      { value: 'c'.repeat(40) },
    ].map((value) => JSON.stringify(value)).join('\n');
    const { engine } = await fixture(source, {
      maxRecordBytes: 128,
      pageHydrationMaxBytes: 60,
      readChunkBytes: 16,
    });

    const first = await engine.getRows({ limit: 3 });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['0']);
    expect(first.hasAfter).toBe(true);

    const second = await engine.getRows({ anchorOrdinal: first.anchorOrdinal, limit: 3 });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['1']);
    expect(second.hasAfter).toBe(true);
  });

  it('collects hydrated samples during the page scan without a second detail read', async () => {
    const { engine } = await fixture('{"type":"message","role":"developer"}\n{"type":"message","role":"assistant"}');
    const samples: Array<{ value?: unknown; ref: { ordinal: string }; parseState: string }> = [];
    await engine.getRows({ limit: 2, columns: [], onHydrated: (record) => samples.push(record) });
    expect(samples.map((sample) => sample.ref.ordinal)).toEqual(['0', '1']);
    expect(samples.map((sample) => sample.parseState)).toEqual(['valid', 'valid']);
    expect(samples[0]?.value).toEqual({ type: 'message', role: 'developer' });
  });

  it('keeps explicit nested columns up to the table cap for physical and sorted pages', async () => {
    const { engine } = await fixture('{"payload":{"field0":"present","field63":63}}', { defaultColumnLimit: 1 });
    const columns: ColumnSpec[] = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, index) => {
      const path = keyPath('payload', `field${String(index)}`);
      return { id: JSON.stringify(path.tokens), label: `$.payload.field${String(index)}`, path, source: 'record' };
    });

    for (const sort of [undefined, { columnId: '__ordinal', direction: 'desc' } as const,
      { columnId: columns[0]!.id, direction: 'asc' } as const]) {
      const page = await engine.getRows({ limit: 1, columns, ...(sort === undefined ? {} : { sort }) });
      expect(page.columns.map((column) => column.id)).toEqual(
        columns.slice(0, MAX_TABLE_COLUMNS).map((column) => column.id),
      );
      expect(page.rows[0]?.cells).toHaveLength(MAX_TABLE_COLUMNS);
      expect(page.rows[0]?.cells.find((cell) => cell.columnId === columns[0]!.id)?.value).toBe('present');
      expect(page.rows[0]?.cells.find((cell) => cell.columnId === columns[63]!.id)?.value).toBe(63);
    }
  });
});

describe('JsonlFileEngine querying and pagination', () => {
  it('evaluates typed predicates without coercion', () => {
    const value = { count: 5, label: 'Alpha', nested: { enabled: true }, empty: null };
    expect(evaluatePredicate({ op: 'compare', path: keyPath('count'), cmp: 'eq', value: 5 }, value)).toBe(true);
    expect(evaluatePredicate({ op: 'compare', path: keyPath('count'), cmp: 'eq', value: '5' }, value)).toBe(false);
    expect(evaluatePredicate({
      op: 'contains',
      path: keyPath('label'),
      value: 'alp',
      caseSensitive: false,
    }, value)).toBe(true);
    expect(evaluatePredicate({ op: 'is_null', path: keyPath('empty') }, value)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: keyPath('missing') }, value)).toBe(false);
    expect(evaluatePredicate({
      op: 'profile_field',
      field: 'eventKind',
      cmp: 'eq',
      value: 'tool_call',
    }, value, { profileFields: { eventKind: 'tool_call' } })).toBe(true);
    expect(evaluatePredicate({
      op: 'profile_field',
      field: 'status',
      cmp: 'ne',
      value: 'error',
    }, value, { profileFields: { status: undefined } })).toBe(false);
    expect(evaluatePredicate({
      op: 'profile_field',
      field: 'status',
      cmp: 'eq',
      value: 'error',
    }, value, { profileFields: {} })).toBe(false);
    expect(evaluatePredicate({
      op: 'profile_text',
      field: 'summary',
      cmp: 'contains',
      value: 'alp',
      caseSensitive: false,
    }, value, { profileFields: { summary: 'Alpha event' } })).toBe(true);
    expect(evaluatePredicate({
      op: 'profile_exists',
      field: 'status',
    }, value, { profileFields: { status: 'ok' } })).toBe(true);
    expect(evaluatePredicate({
      op: 'profile_is_null',
      field: 'error',
    }, value, { profileFields: { error: null } })).toBe(true);
  });

  it('filters forward with exclusive anchors and no duplicates', async () => {
    const source = [
      { id: 0, active: false, name: 'zero' },
      { id: 1, active: true, name: 'one' },
      { id: 2, active: true, name: 'two' },
      { id: 3, active: false, name: 'three' },
      { id: 4, active: true, name: 'four' },
    ].map((value) => JSON.stringify(value)).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 9 });
    const predicate: Predicate = { op: 'compare', path: keyPath('active'), cmp: 'eq', value: true };

    const first = await engine.getRows({ limit: 2, predicate });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['1', '2']);
    expect(first.hasAfter).toBe(true);

    const second = await engine.getRows({ anchorOrdinal: first.anchorOrdinal, limit: 2, predicate });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['4']);
    expect(second.hasAfter).toBe(false);
  });

  it('marks predicate results partial when a record cannot be inspected', async () => {
    const source = `${JSON.stringify({ id: 0, text: 'x'.repeat(100) })}\n${JSON.stringify({ id: 1 })}`;
    const { engine } = await fixture(source, { maxRecordBytes: 32 });
    const page = await engine.getRows({
      limit: 10,
      predicate: { op: 'compare', path: keyPath('id'), cmp: 'eq', value: 1 },
    });
    expect(page.rows.map((row) => row.ref.ordinal)).toEqual(['1']);
    expect(page.scan?.truncatedReason).toBe('uninspectable_record');
  });

  it('sorts the source scan globally with a stable ordinal tie-break and logical offset', async () => {
    const source = [
      { id: 2, label: 'b' },
      { id: 1, label: 'x' },
      { id: 2, label: 'a' },
      { id: 3, label: 'c' },
    ].map((value) => JSON.stringify(value)).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 8 });
    const sort: RowSort = { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' };

    const first = await engine.getRows({ limit: 2, sort });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['1', '0']);
    expect(first.rows.map((row) => row.cells[0]?.preview ?? row.cells[0]?.value)).toEqual([1, 2]);
    expect(first.sortOffset).toBe('0');
    expect(first.matchedRecords).toBe('4');
    expect(first.scan?.truncatedReason).toBeUndefined();
    expect(first.hasAfter).toBe(true);

    const second = await engine.getRows({ limit: 2, sort, sortOffset: '2' });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['2', '3']);
    expect(second.hasBefore).toBe(true);
    expect(second.hasAfter).toBe(false);

    const descending = await engine.getRows({ limit: 4, sort: { ...sort, direction: 'desc' } });
    expect(descending.rows.map((row) => row.ref.ordinal)).toEqual(['3', '0', '2', '1']);
  });

  it.each([
    { name: 'ascending', direction: 'asc', filtered: false, ids: [1, 2] },
    { name: 'descending', direction: 'desc', filtered: false, ids: [3, 2] },
    { name: 'filtered descending', direction: 'desc', filtered: true, ids: [3, 1] },
  ] as const)('projects default columns and cells on a cold $name ordinal page', async ({ direction, filtered, ids }) => {
    const source = [1, 2, 3].map((id) => JSON.stringify({ id, value: `row-${String(id)}` })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 4 });

    const page = await engine.getRows({
      limit: 2,
      sort: { columnId: '__ordinal', direction },
      ...(filtered ? { predicate: { op: 'compare', path: keyPath('id'), cmp: 'ne', value: 2 } as const } : {}),
    });

    expect(page.rows.map((row) => row.ref.ordinal)).toEqual(ids.map((id) => String(id - 1)));
    expect(page.columns.map((column) => column.path)).toEqual([keyPath('id'), keyPath('value')]);
    expect(page.rows.map((row) => row.cells.map((cell) => cell.value ?? cell.preview))).toEqual(
      ids.map((id) => [id, `row-${String(id)}`]),
    );
    expect(page.rows.every((row) => row.cells.map((cell) => cell.columnId).join()
      === page.columns.map((column) => column.id).join())).toBe(true);
  });

  it.each(['asc', 'desc'] as const)('preserves explicit empty columns on a cold %s ordinal page', async (direction) => {
    const { engine } = await fixture('{"id":1}\n{"id":2}');

    const page = await engine.getRows({ limit: 2, sort: { columnId: '__ordinal', direction }, columns: [] });

    expect(page.rows.map((row) => row.ref.ordinal)).toEqual(direction === 'asc' ? ['0', '1'] : ['1', '0']);
    expect(page.columns).toEqual([]);
    expect(page.rows.map((row) => row.cells)).toEqual([[], []]);
  });

  it('pages physical ordinal descending from EOF without the bounded field-sort window', async () => {
    const source = ['zero', 'one', 'two', 'three'].map((value) => JSON.stringify({ value })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 4 });
    const sort: RowSort = { columnId: '__ordinal', direction: 'desc' };

    const first = await engine.getRows({ limit: 2, sort });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['3', '2']);
    expect(first.sortOffset).toBe('0');
    expect(first.matchedRecords).toBe('4');
    expect(first.scan?.truncatedReason).toBeUndefined();
    expect(first.hasBefore).toBe(false);
    expect(first.hasAfter).toBe(true);

    const second = await engine.getRows({ limit: 2, sort, sortOffset: '2' });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['1', '0']);
    expect(second.hasBefore).toBe(true);
    expect(second.hasAfter).toBe(false);
  });

  it('allows physical ordinal pages beyond the retained field-sort window', async () => {
    const source = Array.from({ length: 2_050 }, (_, ordinal) => JSON.stringify({ ordinal })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 64 });
    const page = await engine.getRows({
      limit: 20,
      sort: { columnId: '__ordinal', direction: 'desc' },
      sortOffset: '2040',
    });
    expect(page.rows.map((row) => row.ref.ordinal)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(9 - index)),
    );
    expect(page.hasBefore).toBe(true);
    expect(page.hasAfter).toBe(false);
  }, 15_000);

  for (const direction of ['asc', 'desc'] as const) {
    for (const visibleMatches of [0, 1]) {
      it.each([
        { name: 'records', reason: 'record_limit', budget: { maxExaminedRecords: 3 } },
        { name: 'bytes', reason: 'byte_limit', budget: { maxExaminedBytes: 24n } },
        { name: 'deadline', reason: 'time_limit', budget: { deadlineEpochMs: 2_000 } },
      ])(
        `ends a filtered ordinal ${direction} page with ${visibleMatches} matches when $name run out`,
        async ({ name, reason, budget }) => {
          const source = Array.from({ length: 8 }, (_, id) => JSON.stringify({ id })).join('\n');
          const { engine } = await fixture(source);
          const firstId = direction === 'asc' ? 0 : 7;
          const beyondBudgetId = direction === 'asc' ? 7 : 0;
          const farMatch: Predicate = { op: 'compare', path: keyPath('id'), cmp: 'eq', value: beyondBudgetId };
          const predicate: Predicate = visibleMatches === 0 ? farMatch : {
            op: 'or',
            args: [{ op: 'compare', path: keyPath('id'), cmp: 'eq', value: firstId }, farMatch],
          };
          const clock = name === 'deadline' ? vi.spyOn(Date, 'now').mockReturnValue(1_000) : undefined;
          let hydrated = 0;
          try {
            const page = await engine.getRows({
              limit: 2,
              sort: { columnId: '__ordinal', direction },
              predicate,
              scanBudget: budget,
              onHydrated: () => {
                if (++hydrated === 3) clock?.mockReturnValue(2_000);
              },
            });
            expect(page.rows.map((row) => row.ref.ordinal)).toEqual(
              visibleMatches === 0 ? [] : [String(firstId)],
            );
            expect(page.scan).toMatchObject({ examinedRecords: '3', truncatedReason: reason });
            expect(page.hasAfter).toBe(false);
            expect(page.sortNextOffset).toBeUndefined();
          } finally {
            clock?.mockRestore();
          }
        },
      );
    }

    it(`continues only to known matches within a filtered ordinal ${direction} scan`, async () => {
      const source = Array.from({ length: 8 }, (_, id) => JSON.stringify({ id })).join('\n');
      const { engine } = await fixture(source);
      const request = {
        limit: 2,
        sort: { columnId: '__ordinal', direction },
        predicate: { op: 'compare', path: keyPath('id'), cmp: 'gte', value: 0 } as const,
        scanBudget: { maxExaminedRecords: 3 },
      };
      const first = await engine.getRows(request);
      expect(first.hasAfter).toBe(true);
      const last = await engine.getRows({ ...request, sortOffset: '2' });
      expect(last.rows.map((row) => row.ref.ordinal)).toEqual([direction === 'asc' ? '2' : '5']);
      expect(last.scan?.truncatedReason).toBe('record_limit');
      expect(last.hasAfter).toBe(false);
    });
  }

  it('keeps null and missing sort values last in both directions', async () => {
    const source = [
      { id: null },
      {},
      { id: 2 },
      { id: 1 },
    ].map((value) => JSON.stringify(value)).join('\n');
    const { engine } = await fixture(source);
    const sort: RowSort = { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' };

    const ascending = await engine.getRows({ limit: 4, sort });
    expect(ascending.rows.map((row) => row.ref.ordinal)).toEqual(['3', '2', '0', '1']);

    const descending = await engine.getRows({ limit: 4, sort: { ...sort, direction: 'desc' } });
    expect(descending.rows.map((row) => row.ref.ordinal)).toEqual(['2', '3', '0', '1']);
  });

  it('does not report a false scan limit when an exact budget reaches EOF', async () => {
    const source = ['{"id":1}', '{"id":2}'].join('\n');
    const { engine } = await fixture(source);
    const ascending = await engine.getRows({
      limit: 10,
      sort: { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' },
      scanBudget: { maxExaminedRecords: 2, maxExaminedBytes: '32' },
    });
    expect(ascending.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1']);
    expect(ascending.scan?.truncatedReason).toBeUndefined();
    expect(ascending.hasAfter).toBe(false);

    const physical = await engine.getRows({
      limit: 10,
      scanBudget: { maxExaminedRecords: 2, maxExaminedBytes: '32' },
    });
    expect(physical.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1']);
    expect(physical.scan?.truncatedReason).toBeUndefined();
    expect(physical.hasAfter).toBe(false);

    const backward = await engine.getRows({
      direction: 'backward',
      limit: 10,
      scanBudget: { maxExaminedRecords: 2, maxExaminedBytes: '32' },
    });
    expect(backward.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1']);
    expect(backward.scan?.truncatedReason).toBeUndefined();
    expect(backward.hasBefore).toBe(false);
  });

  it('rejects mixing sorted logical paging with a physical cursor', async () => {
    const { engine } = await fixture('{"id":1}');
    await expect(engine.getRows({
      limit: 1,
      sort: { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' },
      anchorOrdinal: '0',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('reports an explicit bounded scan when sorting a sparse large source', async () => {
    const source = Array.from({ length: 20 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);
    const sort: RowSort = { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' };
    const page = await engine.getRows({
      limit: 2,
      sort,
      scanBudget: { maxExaminedRecords: 3, maxExaminedBytes: 1_024n },
    });
    expect(page.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1']);
    expect(page.scan).toMatchObject({ examinedRecords: '3', cursorOrdinal: '2', truncatedReason: 'record_limit' });
    expect(page.scan?.direction).toBeUndefined();
    expect(page.hasAfter).toBe(true);
  });

  it('resumes a sparse sorted page from the retained logical window', async () => {
    const source = Array.from({ length: 20 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);
    const sort: RowSort = { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' };
    const first = await engine.getRows({
      limit: 2,
      sort,
      scanBudget: { maxExaminedRecords: 3, maxExaminedBytes: 1_024n },
    });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1']);
    expect(first.hasAfter).toBe(true);

    const second = await engine.getRows({
      limit: 2,
      sort,
      sortOffset: '2',
      scanBudget: { maxExaminedRecords: 3, maxExaminedBytes: 1_024n },
    });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['2']);
    expect(second.hasAfter).toBe(false);
  });

  it('keeps sorted candidate memory bounded and exposes a hydration continuation', async () => {
    const source = [
      JSON.stringify({ id: 0, text: 'a'.repeat(30) }),
      JSON.stringify({ id: 1, text: 'b'.repeat(30) }),
    ].join('\n');
    const { engine } = await fixture(source, { pageHydrationMaxBytes: 80 });
    const sort: RowSort = { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' };
    const first = await engine.getRows({ limit: 2, sort });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['0']);
    expect(first.scan?.truncatedReason).toBe('hydration_limit');
    expect(first.sortNextOffset).toBe('1');

    if (first.sortNextOffset === undefined) throw new Error('Expected a sorted hydration continuation offset.');
    const second = await engine.getRows({ limit: 2, sort, sortOffset: first.sortNextOffset });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['1']);
    expect(second.hasAfter).toBe(false);
  });

  it('rejects a sorted page that would exceed the retained result window', async () => {
    const { engine } = await fixture('{"id":1}');
    const sort: RowSort = { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'asc' };
    await expect(engine.getRows({ limit: 500, sort, sortOffset: '2048' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects malformed encoded field paths before sort evaluation', async () => {
    const { engine } = await fixture('{"id":1}');
    await expect(engine.getRows({
      limit: 1,
      sort: { columnId: JSON.stringify([{ kind: 'index', value: -1 }]), direction: 'asc' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(engine.getRows({
      limit: 1,
      sort: { columnId: JSON.stringify([{ kind: 'key', value: 42 }]), direction: 'asc' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('bounds sparse scans by examined records and resumes from the physical cursor', async () => {
    const source = Array.from({ length: 10 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 7 });
    const predicate: Predicate = { op: 'compare', path: keyPath('id'), cmp: 'eq', value: 5 };

    const first = await engine.getRows({
      limit: 10,
      predicate,
      scanBudget: { maxExaminedRecords: 3, maxExaminedBytes: 1_024n },
    });
    expect(first.rows).toEqual([]);
    expect(first.scan).toEqual({
      examinedRecords: '3',
      examinedBytes: '24',
      cursorOrdinal: '2',
      direction: 'forward',
      truncatedReason: 'record_limit',
    });
    expect(first.hasAfter).toBe(true);
    const firstCursor = first.scan?.cursorOrdinal;
    if (firstCursor === undefined) throw new Error('Expected a physical scan cursor.');

    const second = await engine.getRows({
      anchorOrdinal: firstCursor,
      limit: 10,
      predicate,
      scanBudget: { maxExaminedRecords: 3, maxExaminedBytes: 1_024n },
    });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['5']);
    expect(second.scan).toMatchObject({
      examinedRecords: '3',
      cursorOrdinal: '5',
      truncatedReason: 'record_limit',
    });
  });

  it('does not hydrate or skip a record beyond the logical byte budget', async () => {
    const { engine } = await fixture('{"id":0}\n{"id":1}');

    const blocked = await engine.getRows({
      limit: 10,
      scanBudget: { maxExaminedBytes: 7n },
    });
    expect(blocked.rows).toEqual([]);
    expect(blocked.scan).toEqual({
      examinedRecords: '0',
      examinedBytes: '0',
      direction: 'forward',
      truncatedReason: 'byte_limit',
    });

    const resumed = await engine.getRows({
      limit: 1,
      scanBudget: { maxExaminedRecords: 10, maxExaminedBytes: 16n },
    });
    expect(resumed.rows.map((row) => row.ref.ordinal)).toEqual(['0']);
    expect(resumed.scan?.cursorOrdinal).toBe('0');
    expect(resumed.hasAfter).toBe(true);
  });

  it('keeps both continuation sides reachable for empty bounded scans', async () => {
    const source = Array.from({ length: 12 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);
    const predicate: Predicate = { op: 'compare', path: keyPath('id'), cmp: 'eq', value: 11 };

    const forward = await engine.getRows({
      anchorOrdinal: '4',
      direction: 'forward',
      limit: 2,
      predicate,
      scanBudget: { maxExaminedRecords: 2, maxExaminedBytes: 1_024n },
    });
    expect(forward.rows).toEqual([]);
    expect(forward.scan).toMatchObject({ direction: 'forward', cursorOrdinal: '6', truncatedReason: 'record_limit' });
    expect(forward.hasBefore).toBe(true);
    expect(forward.hasAfter).toBe(true);

    const backward = await engine.getRows({
      anchorOrdinal: '8',
      direction: 'backward',
      limit: 2,
      predicate,
      scanBudget: { maxExaminedRecords: 2, maxExaminedBytes: 1_024n },
    });
    expect(backward.rows).toEqual([]);
    expect(backward.scan).toMatchObject({ direction: 'backward', cursorOrdinal: '6', truncatedReason: 'record_limit' });
    expect(backward.hasBefore).toBe(true);
    expect(backward.hasAfter).toBe(true);
  });

  it('continues an empty forward scan exclusively from a partially indexed boundary', async () => {
    const source = Array.from({ length: 20 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 8 });
    const partial = await engine.indexMore({ maxBytes: 9 });
    expect(partial).toMatchObject({ indexedRecords: '1', indexingComplete: false });

    const predicate: Predicate = { op: 'compare', path: keyPath('id'), cmp: 'eq', value: 19 };
    const first = await engine.getRows({
      anchorOrdinal: '0',
      direction: 'forward',
      limit: 2,
      predicate,
      scanBudget: { maxExaminedRecords: 2 },
    });

    expect(first.rows).toEqual([]);
    expect(first.scan).toMatchObject({
      examinedRecords: '2',
      cursorOrdinal: '2',
      direction: 'forward',
      truncatedReason: 'record_limit',
    });
    expect(first.hasAfter).toBe(true);

    const continuation = first.scan?.cursorOrdinal;
    if (continuation === undefined) throw new Error('Expected a physical continuation cursor.');
    const resumed = await engine.getRows({
      anchorOrdinal: continuation,
      direction: 'forward',
      limit: 2,
      predicate,
      scanBudget: { maxExaminedRecords: 2 },
    });
    expect(resumed.rows).toEqual([]);
    expect(resumed.scan?.cursorOrdinal).toBe('4');
    expect(resumed.hasAfter).toBe(true);
  });

  it('advances an oversized matching record on the next page without looping', async () => {
    const source = [
      JSON.stringify({ id: 0, text: 'a'.repeat(30) }),
      JSON.stringify({ id: 1, text: 'b'.repeat(30) }),
    ].join('\n');
    const { engine } = await fixture(source, { pageHydrationMaxBytes: 80 });
    const first = await engine.getRows({ limit: 2 });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['0']);
    expect(first.scan?.truncatedReason).toBe('hydration_limit');
    const continuation = first.scan?.cursorOrdinal;
    if (continuation === undefined) throw new Error('Expected a hydration continuation cursor.');
    const second = await engine.getRows({
      anchorOrdinal: continuation,
      direction: 'forward',
      limit: 2,
    });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['1']);
  });

  it('bounds backward scans and stops expired scans before hydration', async () => {
    const source = Array.from({ length: 10 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);

    const bounded = await engine.getRows({
      direction: 'backward',
      limit: 10,
      scanBudget: { maxExaminedRecords: 3, maxExaminedBytes: 1_024n },
    });
    expect(bounded.rows.map((row) => row.ref.ordinal)).toEqual(['7', '8', '9']);
    expect(bounded.scan).toMatchObject({
      examinedRecords: '3',
      cursorOrdinal: '7',
      truncatedReason: 'record_limit',
    });
    expect(bounded.hasBefore).toBe(true);

    const expired = await engine.getRows({
      direction: 'backward',
      scanBudget: { deadlineEpochMs: Date.now() - 1 },
    });
    expect(expired.rows).toEqual([]);
    expect(expired.scan).toEqual({
      examinedRecords: '0',
      examinedBytes: '0',
      direction: 'backward',
      truncatedReason: 'time_limit',
    });
  });

  it('paginates backward in physical display order', async () => {
    const { engine } = await fixture('0\n1\n2\n3', { readChunkBytes: 4, segmentTargetRecords: 2 });

    const latest = await engine.getRows({ direction: 'backward', limit: 2 });
    expect(latest.rows.map((row) => row.ref.ordinal)).toEqual(['2', '3']);
    expect(latest.anchorOrdinal).toBe('2');
    expect(latest.hasBefore).toBe(true);

    const older = await engine.getRows({
      anchorOrdinal: latest.anchorOrdinal,
      direction: 'backward',
      limit: 2,
    });
    expect(older.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1']);
    expect(older.hasBefore).toBe(false);
    expect(older.hasAfter).toBe(true);
  });

  it('walks descending physical windows forward and back without gaps or duplicates', async () => {
    const source = Array.from({ length: 225 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 31, segmentTargetRecords: 17 });
    const sort: RowSort = { columnId: '__ordinal', direction: 'desc' };
    const ordinals = (page: Awaited<ReturnType<typeof engine.getRows>>) =>
      page.rows.map((row) => BigInt(row.ref.ordinal));
    const descending = Array.from({ length: 225 }, (_, index) => BigInt(224 - index));

    const first = await engine.getRows({ direction: 'backward', limit: 100, sort });
    const second = await engine.getRows({
      anchorOrdinal: first.rows.at(-1)!.ref.ordinal,
      direction: 'backward',
      limit: 100,
      sort,
    });
    const partial = await engine.getRows({
      anchorOrdinal: second.rows.at(-1)!.ref.ordinal,
      direction: 'backward',
      limit: 100,
      sort,
    });

    expect([...ordinals(first), ...ordinals(second), ...ordinals(partial)]).toEqual(descending);
    expect([first.rows.length, second.rows.length, partial.rows.length]).toEqual([100, 100, 25]);
    expect(first).toMatchObject({ hasBefore: false, hasAfter: true });
    expect(second).toMatchObject({ hasBefore: true, hasAfter: true });
    expect(partial).toMatchObject({ hasBefore: true, hasAfter: false });

    const backToSecond = await engine.getRows({
      anchorOrdinal: partial.rows[0]!.ref.ordinal,
      direction: 'forward',
      limit: 100,
      sort,
    });
    const backToFirst = await engine.getRows({
      anchorOrdinal: backToSecond.rows[0]!.ref.ordinal,
      direction: 'forward',
      limit: 100,
      sort,
    });
    expect(ordinals(backToSecond)).toEqual(ordinals(second));
    expect(ordinals(backToFirst)).toEqual(ordinals(first));
  }, 15_000);

  it('continues bounded descending scans and stops a zero-progress cursor', async () => {
    const source = Array.from({ length: 8 }, (_, id) => JSON.stringify({ id })).join('\n');
    const { engine } = await fixture(source);
    const sort: RowSort = { columnId: '__ordinal', direction: 'desc' };
    const predicate: Predicate = { op: 'compare', path: keyPath('id'), cmp: 'eq', value: 0 };
    const budget = { maxExaminedRecords: 3, maxExaminedBytes: 1_024n };

    const first = await engine.getRows({ direction: 'backward', limit: 2, sort, predicate, scanBudget: budget });
    expect(first.rows).toEqual([]);
    expect(first.scan).toMatchObject({ cursorOrdinal: '5', direction: 'backward', truncatedReason: 'record_limit' });
    expect(first.hasAfter).toBe(true);
    const second = await engine.getRows({
      anchorOrdinal: first.scan!.cursorOrdinal!,
      direction: 'backward',
      limit: 2,
      sort,
      predicate,
      scanBudget: budget,
    });
    expect(second.rows).toEqual([]);
    expect(second.scan).toMatchObject({ cursorOrdinal: '2', direction: 'backward', truncatedReason: 'record_limit' });
    expect(second.hasAfter).toBe(true);
    const third = await engine.getRows({
      anchorOrdinal: second.scan!.cursorOrdinal!,
      direction: 'backward',
      limit: 2,
      sort,
      predicate,
      scanBudget: budget,
    });
    expect(third.rows.map((row) => row.ref.ordinal)).toEqual(['0']);
    expect(third.hasAfter).toBe(false);

    const expired = await engine.getRows({
      anchorOrdinal: '5',
      direction: 'backward',
      limit: 2,
      sort,
      scanBudget: { deadlineEpochMs: Date.now() - 1 },
    });
    expect(expired.rows).toEqual([]);
    expect(expired.scan).toMatchObject({ examinedRecords: '0', direction: 'backward', truncatedReason: 'time_limit' });
    expect(expired.hasAfter).toBe(false);
  });

  it('rejects ambiguous physical and logical sort cursors', async () => {
    const { engine } = await fixture('{\"id\":0}\n{\"id\":1}');
    await expect(engine.getRows({
      anchorOrdinal: '1',
      direction: 'backward',
      limit: 1,
      sort: { columnId: '__ordinal', direction: 'desc' },
      sortOffset: '0',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(engine.getRows({
      anchorOrdinal: '1',
      direction: 'backward',
      limit: 1,
      sort: { columnId: JSON.stringify([{ kind: 'key', value: 'id' }]), direction: 'desc' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects stale generations and already-cancelled work', async () => {
    const { engine } = await fixture('{"a":1}');
    await expect(engine.getRows({ generation: 'stale' })).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(engine.getRows({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(engine.inspectRows({ generation: 'stale' })).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    await expect(engine.inspectRows({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects work beyond the configured owner-queue bound', async () => {
    const source = Array.from({ length: 100 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, {
      readChunkBytes: 4,
      maxQueuedOperations: 1,
    });

    const indexing = engine.finishIndexing();
    await expect(engine.getRows()).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    await indexing;
  });
});

describe('JsonlFileEngine refresh classification and lifecycle', () => {
  it('classifies an append without adopting bytes outside the open snapshot', async () => {
    const { engine, path } = await fixture('{"a":1}\n');
    const original = (await engine.getRows({ limit: 10 })).rows[0]!.ref;
    await appendFile(path, '{"a":2}\n');

    expect(await engine.classifyRefresh()).toMatchObject({ kind: 'append' });
    const page = await engine.getRows({ limit: 10 });
    expect(page.rows).toHaveLength(1);
    expect(page.totalRecords).toBe('1');
    expect(page.rows[0]?.genericSummary).toBe('{"a":1}');
    expect((await engine.getDetail(original)).value).toEqual({ a: 1 });

    await writeFile(path, '{"a":3}\n{"a":2}\n');
    await expect(engine.getDetail(original)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('keeps an unverified append readable while recovery waits for a stable baseline', async () => {
    const { engine, path } = await fixture('{"value":true}\n'.repeat(600_000));
    expect(engine.canValidateOriginalSnapshot).toBe(false);
    await appendFile(path, '{"value":false}\n');

    expect(await engine.classifyRefresh()).toMatchObject({ kind: 'unknown' });
    const page = await engine.getRows({ limit: 1 });
    expect(page.rows[0]?.genericSummary).toBe('{"value":true}');
    expect(engine.getDiagnostics().open).toBe(true);
  }, 15_000);

  it('keeps a large snapshot readable after establishing its baseline before an append', async () => {
    const { engine, path } = await fixture('{"value":true}\n'.repeat(600_000));
    expect(engine.canValidateOriginalSnapshot).toBe(false);
    expect(await engine.classifyRefresh()).toMatchObject({ kind: 'unchanged' });
    expect(engine.canValidateOriginalSnapshot).toBe(true);
    await appendFile(path, '{"value":false}\n');

    expect(await engine.classifyRefresh()).toMatchObject({ kind: 'append' });
    const page = await engine.getRows({ limit: 1 });
    expect(page.rows[0]?.genericSummary).toBe('{"value":true}');
  }, 15_000);

  it('rejects an equal-length rewrite even when no filesystem watcher runs', async () => {
    const { engine, path } = await fixture('{"a":1}\n');
    await writeFile(path, '{"b":2}\n');
    const forcedMtime = new Date(Date.now() + 2_000);
    await utimes(path, forcedMtime, forcedMtime);

    await expect(engine.getRows({ limit: 10 })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('does not classify a middle rewrite followed by append as append-only growth', async () => {
    const lines = Array.from(
      { length: 20_000 },
      (_, index) => `{"id":${String(index).padStart(5, '0')},"value":"${'x'.repeat(24)}"}`,
    );
    const source = `${lines.join('\n')}\n`;
    const { engine, path } = await fixture(source);

    // Force the exact baseline to be ready before introducing the mutation.
    await expect(engine.classifyRefresh()).resolves.toMatchObject({ kind: 'unchanged' });

    const target = lines[10_000]!;
    const targetOffset = Buffer.byteLength(source.slice(0, source.indexOf(target)))
      + target.indexOf('x');
    const writer = await open(path, 'r+');
    try {
      await writer.write(Buffer.from('y'), 0, 1, targetOffset);
    } finally {
      await writer.close();
    }
    await appendFile(path, '{"id":20000,"value":"tail"}\n');

    await expect(engine.classifyRefresh()).resolves.toMatchObject({ kind: 'replace' });
    await expect(engine.getRows({ limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  }, 15_000);

  it('classifies truncation and replacement evidence', async () => {
    const truncated = await fixture('{"a":1}\n{"a":2}\n');
    await truncate(truncated.path, 4);
    expect(await truncated.engine.classifyRefresh()).toMatchObject({ kind: 'truncate' });

    const replaced = await fixture('{"a":1}\n');
    await writeFile(replaced.path, '{"b":2}\n');
    expect(await replaced.engine.classifyRefresh()).toMatchObject({ kind: 'replace' });
  });

  it('stops background indexing and closes cleanly', async () => {
    const source = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 64 });
    const background = engine.startBackgroundIndexing();
    background.cancel();
    await expect(background.done).resolves.toBeUndefined();

    await engine.dispose();
    const index = engines.indexOf(engine);
    if (index >= 0) engines.splice(index, 1);
    expect(engine.getDiagnostics().open).toBe(false);
    expect(() => engine.getRows()).toThrow(JsonlEngineError);
  });

  it('throttles background progress reports while always reporting completion', async () => {
    const source = Array.from({ length: 500 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 64 });
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock++);
    const updates: boolean[] = [];

    try {
      const background = engine.startBackgroundIndexing((summary) => {
        updates.push(summary.indexingComplete);
      });
      await background.done;
    } finally {
      now.mockRestore();
    }

    expect(updates.length).toBeLessThan(20);
    expect(updates[0]).toBe(false);
    expect(updates.at(-1)).toBe(true);
  });

  it('prioritizes foreground work and records its scheduler blocker', async () => {
    const source = Array.from({ length: 100 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 64 });
    const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
    const originalRead = handle.read.bind(handle) as PositionalRead;
    const reads = spyOnPositionalReads(engine);
    let notifyReadStarted!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    reads.mockImplementation(async (buffer, offset, length, position) => {
      notifyReadStarted();
      await readGate;
      return originalRead(buffer, offset, length, position);
    });
    const executor = (engine as unknown as {
      executor: { activeOperation: string | undefined; dispatch: () => void };
    }).executor;
    const dispatch = executor.dispatch.bind(executor);
    const operationOrder: string[] = [];
    let queryBlockedBy: string | undefined;
    const dispatchSpy = vi.spyOn(executor, 'dispatch').mockImplementation(() => {
      const idle = executor.activeOperation === undefined;
      dispatch();
      if (idle && executor.activeOperation !== undefined) operationOrder.push(executor.activeOperation);
    });

    try {
      const firstBackground = engine.startBackgroundIndexing();
      await readStarted;
      const secondBackground = engine.startBackgroundIndexing();
      const refresh = engine.classifyRefresh();
      const interactive = engine.getRows({
        limit: 1,
        onTiming: (timing) => { queryBlockedBy = timing.queueBlockedBy; },
      });
      releaseRead();
      await Promise.all([firstBackground.done, secondBackground.done, refresh, interactive]);
    } finally {
      releaseRead();
      dispatchSpy.mockRestore();
      reads.mockRestore();
    }

    expect(operationOrder[0]).toBe('index_more');
    expect(operationOrder[1]).toBe('classify_refresh');
    expect(operationOrder[2]).toBe('get_rows');
    expect(operationOrder.indexOf('get_rows')).toBeLessThan(operationOrder.lastIndexOf('index_more'));
    expect(queryBlockedBy).toBe('classify_refresh');
  });

  it('does not let a throwing progress observer stop background indexing', async () => {
    const source = Array.from({ length: 50 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 64 });
    const background = engine.startBackgroundIndexing(() => {
      throw new Error('observer failed');
    });

    await expect(background.done).resolves.toBeUndefined();
    expect(engine.getSummary().indexingComplete).toBe(true);
  });

  it('runs an interactive query before scheduling the next background index slice', async () => {
    const source = Array.from({ length: 500 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 64 });
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock += 100);
    const order: string[] = [];
    let interactive: Promise<unknown> | undefined;
    let progressCount = 0;

    try {
      const background = engine.startBackgroundIndexing(() => {
        progressCount += 1;
        order.push(`progress-${progressCount}`);
        if (progressCount === 1) {
          interactive = engine.getRows({ limit: 1 }).then((page) => {
            order.push('interactive');
            return page;
          });
        }
      });
      await background.done;
      await interactive;
    } finally {
      now.mockRestore();
    }

    expect(order.indexOf('interactive')).toBeGreaterThan(-1);
    expect(order.indexOf('interactive')).toBeLessThan(order.indexOf('progress-2'));
  });

  it('lets an interactive query run between 1 MiB background index slices', async () => {
    const source = Array.from({ length: 150_000 }, (_, index) => JSON.stringify({ index })).join('\n');
    const { engine } = await fixture(source, { readChunkBytes: 1024 * 1024 });
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock += 100);
    const order: string[] = [];
    let interactive: Promise<unknown> | undefined;
    let progressCount = 0;

    try {
      const background = engine.startBackgroundIndexing(() => {
        progressCount += 1;
        order.push(`progress-${progressCount}`);
        if (progressCount === 1) {
          interactive = engine.getRows({ limit: 1 }).then((page) => {
            order.push('interactive');
            return page;
          });
        }
      });
      await background.done;
      await interactive;
    } finally {
      now.mockRestore();
    }

    expect(order.indexOf('interactive')).toBeGreaterThan(-1);
    expect(order.indexOf('interactive')).toBeLessThan(order.indexOf('progress-2'));
  });
});
