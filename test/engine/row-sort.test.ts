import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';
import {
  compareSortValues,
  insertSortCandidate,
  isOrdinalSort,
  normalizeRowSort,
  sortColumnFromId,
  sortValueForColumn,
} from '../../src/engine/row-sort';
import type { ColumnSpec, RowSort } from '../../src/shared/types';

const temporaryDirectories: string[] = [];
const engines: JsonlFileEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map(async (engine) => engine.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function fixture(contents: string, options: Parameters<typeof JsonlFileEngine.open>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-row-sort-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'fixture.jsonl');
  await writeFile(path, contents);
  const engine = await JsonlFileEngine.open(path, options);
  engines.push(engine);
  return engine;
}

describe('row-sort pure policy', () => {
  it('normalizes bounded sort requests and routes ordinal sorting', () => {
    expect(normalizeRowSort({ columnId: 'id', direction: 'asc' })).toEqual({ columnId: 'id', direction: 'asc' });
    expect(normalizeRowSort(undefined)).toBeUndefined();
    expect(isOrdinalSort({ columnId: '__ordinal', direction: 'asc' })).toBe(true);
    expect(isOrdinalSort({ columnId: '$ordinal', direction: 'desc' })).toBe(true);
    expect(isOrdinalSort({ columnId: 'id', direction: 'asc' })).toBe(false);
    expect(() => normalizeRowSort({ columnId: '', direction: 'asc' })).toThrow();
  });

  it('compares mixed JSON types and keeps null and missing values last both ways', () => {
    const values: unknown[] = [true, 'text', { b: 1 }, 2, [1], null, undefined, false, 1.5, 'a'];
    const ascending = [...values].sort((left, right) => compareSortValues(left, right, 'asc'));
    expect(ascending).toEqual([[1], false, true, 1.5, 2, { b: 1 }, 'a', 'text', null, undefined]);

    const descending = [...values].sort((left, right) => compareSortValues(left, right, 'desc'));
    expect(descending).toEqual(['text', 'a', { b: 1 }, 2, 1.5, true, false, [1], null, undefined]);
    expect(compareSortValues(null, undefined, 'asc')).toBe(0);
  });

  it('resolves encoded and plain-key columns and extracts record, profile, and ordinal keys', () => {
    const encodedId = JSON.stringify([{ kind: 'key', value: 'outer' }, { kind: 'index', value: 0 }]);
    const encoded = sortColumnFromId(encodedId);
    expect(encoded).toMatchObject({ id: encodedId, source: 'record', path: { tokens: [
      { kind: 'key', value: 'outer' }, { kind: 'index', value: 0 },
    ] } });
    expect(sortColumnFromId('plain_key')).toMatchObject({
      id: 'plain_key', path: { tokens: [{ kind: 'key', value: 'plain_key' }] },
    });
    expect(sortColumnFromId('{"kind":"bad"}')).toBeUndefined();

    const recordColumn = encoded as ColumnSpec;
    expect(sortValueForColumn({ internal: { ordinal: 7n }, value: { outer: ['value'] } }, recordColumn, undefined))
      .toBe('value');
    expect(sortValueForColumn({ internal: { ordinal: 7n }, value: {} }, recordColumn, undefined)).toBeUndefined();
    expect(sortValueForColumn(
      { internal: { ordinal: 7n }, value: {} },
      { id: 'model', label: 'Model', source: 'profile' },
      {
        profileId: 'sample',
        eventKind: 'message',
        summary: 'sample',
        model: 'gpt-test',
        evidence: [],
        confidence: 'source',
      },
    )).toBe('gpt-test');
    expect(sortValueForColumn(
      { internal: { ordinal: 7n }, value: {} },
      { id: '__ordinal', label: '#', source: 'system' },
      undefined,
    )).toBe(7n);
  });

  it('retains windowEnd plus one candidates with ordinal tie order', () => {
    const candidates: Array<{ internal: { ordinal: bigint }; key: unknown }> = [];
    const scanned = [
      { ordinal: 0n, key: 9 },
      { ordinal: 1n, key: 1 },
      { ordinal: 2n, key: 7 },
      { ordinal: 3n, key: 2 },
      { ordinal: 4n, key: 2 },
      { ordinal: 5n, key: 3 },
    ];
    const offset = 2;
    const pageLimit = 1;
    const windowEnd = offset + pageLimit;
    const retainLimit = windowEnd + 1;
    for (const candidate of scanned) {
      insertSortCandidate(candidates, { internal: { ordinal: candidate.ordinal }, key: candidate.key }, 'asc', retainLimit);
    }

    expect(candidates.map((candidate) => [candidate.key, candidate.internal.ordinal])).toEqual([
      [1, 1n], [2, 3n], [2, 4n], [3, 5n],
    ]);
    expect(candidates.slice(offset, windowEnd).map((candidate) => candidate.internal.ordinal)).toEqual([4n]);
    expect(candidates.length > windowEnd).toBe(true);
  });
});

describe('JsonlFileEngine sort facade', () => {
  it('keeps sorted continuation and EOF output stable through the facade', async () => {
    const engine = await fixture(['{"id":2}', '{"id":1}', '{"id":3}'].join('\n'));
    const sort: RowSort = {
      columnId: JSON.stringify([{ kind: 'key', value: 'id' }]),
      direction: 'asc',
    };

    const first = await engine.getRows({ limit: 2, sort });
    expect(first.rows.map((row) => [row.ref.ordinal, row.cells[0]?.value ?? row.cells[0]?.preview])).toEqual([
      ['1', 1], ['0', 2],
    ]);
    expect(first).toMatchObject({ sortOffset: '0', hasBefore: false, hasAfter: true, matchedRecords: '3' });
    expect(first.scan?.truncatedReason).toBeUndefined();

    const continuation = await engine.getRows({ limit: 2, sort, sortOffset: '2' });
    expect(continuation.rows.map((row) => row.ref.ordinal)).toEqual(['2']);
    expect(continuation).toMatchObject({ sortOffset: '2', hasBefore: true, hasAfter: false, matchedRecords: '3' });
    expect(continuation.scan?.truncatedReason).toBeUndefined();
  });

  it('exposes hydration continuation and completes at EOF without losing a sorted row', async () => {
    const source = [
      JSON.stringify({ id: 0, text: 'a'.repeat(30) }),
      JSON.stringify({ id: 1, text: 'b'.repeat(30) }),
    ].join('\n');
    const engine = await fixture(source, { pageHydrationMaxBytes: 80 });
    const sort: RowSort = {
      columnId: JSON.stringify([{ kind: 'key', value: 'id' }]),
      direction: 'asc',
    };

    const first = await engine.getRows({ limit: 2, sort });
    expect(first.rows.map((row) => row.ref.ordinal)).toEqual(['0']);
    expect(first.sortNextOffset).toBe('1');
    expect(first.scan?.truncatedReason).toBe('hydration_limit');

    const nextOffset = first.sortNextOffset;
    if (nextOffset === undefined) throw new Error('Expected a sorted hydration continuation offset.');
    const second = await engine.getRows({ limit: 2, sort, sortOffset: nextOffset });
    expect(second.rows.map((row) => row.ref.ordinal)).toEqual(['1']);
    expect(second.sortNextOffset).toBeUndefined();
    expect(second.hasAfter).toBe(false);
    expect(second.scan?.truncatedReason).toBeUndefined();
  });
});
