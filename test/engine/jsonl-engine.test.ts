import { appendFile, mkdtemp, open, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonlEngineError,
  JsonlFileEngine,
  evaluatePredicate,
} from '../../src/engine';
import { keyPath, type Predicate } from '../../src/shared/types';
import { AdaptiveSegmentIndex, type InternalRecordRef } from '../../src/engine/segment-index';
import { createNewlineScanner } from '../../src/engine/newline-scanner';

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

describe('JsonlFileEngine indexing and hydration', () => {
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

  it('preserves blank, malformed JSON, malformed UTF-8, and scalar records', async () => {
    const bytes = Buffer.concat([
      Buffer.from('\n{bad}\n42\n"ok"\n'),
      Buffer.from([0xff, 0x0a]),
      Buffer.from('null'),
    ]);
    const { engine } = await fixture(bytes, { readChunkBytes: 4 });

    const page = await engine.getRows({ limit: 20 });

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
    expect(page.rows[4]?.problems?.[0]?.code).toBe('INVALID_UTF8');
    expect(page.rows[2]?.kind).toBe('integer');
    expect(page.rows[3]?.kind).toBe('string');
    expect(page.rows[5]?.kind).toBe('null');
    expect(engine.getSummary()).toMatchObject({ validRecords: '3', problemRecords: '3' });
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

  it('rejects scan budgets for backward pages and stops expired scans before hydration', async () => {
    const { engine } = await fixture('{"id":0}');

    await expect(engine.getRows({
      direction: 'backward',
      scanBudget: { maxExaminedRecords: 1 },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const expired = await engine.getRows({
      scanBudget: { deadlineEpochMs: Date.now() - 1 },
    });
    expect(expired.rows).toEqual([]);
    expect(expired.scan).toEqual({
      examinedRecords: '0',
      examinedBytes: '0',
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

  it('rejects stale generations and already-cancelled work', async () => {
    const { engine } = await fixture('{"a":1}');
    await expect(engine.getRows({ generation: 'stale' })).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(engine.getRows({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
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
    await appendFile(path, '{"a":2}\n');

    expect(await engine.classifyRefresh()).toMatchObject({ kind: 'append' });
    const page = await engine.getRows({ limit: 10 });
    expect(page.rows).toHaveLength(1);
    expect(page.totalRecords).toBe('1');
    expect(page.rows[0]?.genericSummary).toBe('{"a":1}');
  });

  it('rejects an equal-length rewrite even when no filesystem watcher runs', async () => {
    const { engine, path } = await fixture('{"a":1}\n');
    await writeFile(path, '{"b":2}\n');
    const forcedMtime = new Date(Date.now() + 2_000);
    await utimes(path, forcedMtime, forcedMtime);

    await expect(engine.getRows({ limit: 10 })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

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
});
