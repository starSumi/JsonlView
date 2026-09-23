import { describe, expect, it } from 'vitest';
import { keyPath, type ColumnSpec } from '../../src/shared/types';
import {
  buildRecordQueryRequest,
  canRequestSortedPage,
  createFilterScanBudget,
  isPhysicalOrdinalSort,
  textPredicate,
} from '../../src/webview/features/record-query';
import { rowsOptionsAfterEmptyRebuild } from '../../src/webview/paging';

const columns: ColumnSpec[] = [{
  id: JSON.stringify([{ kind: 'key', value: 'status' }]),
  label: 'Status',
  source: 'record',
  path: keyPath('status'),
}];

describe('record-query vertical slice', () => {
  it('builds a bounded filtered rows request without changing the IPC payload shape', () => {
    const payload = buildRecordQueryRequest({
      limit: 100,
      query: 'error',
      filter: { columnId: columns[0]!.id, operator: 'eq', value: 'failed', source: 'record', path: keyPath('status') },
      filterColumns: columns,
      anchorOrdinal: '10',
      direction: 'forward',
      now: 1_000,
    });

    expect(payload).toMatchObject({
      limit: 100,
      anchorOrdinal: '10',
      direction: 'forward',
      scanBudget: {
        maxExaminedRecords: 100_000,
        maxExaminedBytes: String(64 * 1024 * 1024),
        deadlineEpochMs: 6_000,
      },
    });
    expect(payload.predicate).toEqual({
      op: 'and',
      args: [
        { op: 'text_search', value: 'error', caseSensitive: false },
        { op: 'compare', path: keyPath('status'), cmp: 'eq', value: 'failed' },
      ],
    });
  });

  it('keeps sorted logical paging bounded while allowing physical ordinal pages', () => {
    expect(isPhysicalOrdinalSort({ columnId: '__ordinal', direction: 'desc' })).toBe(true);
    expect(isPhysicalOrdinalSort({ columnId: 'status', direction: 'desc' })).toBe(false);
    expect(canRequestSortedPage({ columnId: 'status', direction: 'asc' }, 2_000n, 100)).toBe(false);
    expect(canRequestSortedPage({ columnId: '__ordinal', direction: 'desc' }, 20_000n, 100)).toBe(true);
  });

  it('keeps text predicates and scan deadlines deterministic when requested', () => {
    expect(textPredicate('  ')).toBeUndefined();
    expect(textPredicate('  hello ')).toEqual({ op: 'text_search', value: 'hello', caseSensitive: false });
    expect(createFilterScanBudget(10)).toEqual({
      maxExaminedRecords: 100_000,
      maxExaminedBytes: String(64 * 1024 * 1024),
      deadlineEpochMs: 5_010,
    });
  });

  it('composes a changed sorted request after rebuild clamps an empty page', () => {
    const fallback = rowsOptionsAfterEmptyRebuild(undefined, '4', 100, '1000', '', '300', '150');
    expect(fallback).toEqual({ sortOffset: '100' });
    const sortOffset = fallback?.sortOffset;
    if (sortOffset === undefined) throw new Error('expected sorted rebuild fallback');
    const payload = buildRecordQueryRequest({
      limit: 100,
      filterColumns: columns,
      sort: { columnId: columns[0]!.id, direction: 'asc' },
      sortOffset,
    });

    expect(payload).toMatchObject({
      limit: 100,
      sort: { columnId: columns[0]!.id, direction: 'asc' },
      sortOffset: '100',
    });
  });
});
