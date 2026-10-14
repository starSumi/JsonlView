import { describe, expect, it } from 'vitest';
import { MAX_TABLE_COLUMNS, keyPath, type ColumnSpec, type FieldStats } from '../../src/shared/types';
import {
  buildRecordQueryRequest,
  buildStructuredFilter,
  canRequestSortedPage,
  createFilterScanBudget,
  isPhysicalOrdinalSort,
  recordColumnCandidates,
  recordColumnOptions,
  selectedRecordColumns,
  textPredicate,
} from '../../src/webview/features/record-query';
import { rowsOptionsAfterEmptyRebuild } from '../../src/webview/paging';
import { columnsAfterProfileChange, configuredRecordColumns } from '../../src/webview/features/record-query/model';

const columns: ColumnSpec[] = [{
  id: JSON.stringify([{ kind: 'key', value: 'status' }]),
  label: 'Status',
  source: 'record',
  path: keyPath('status'),
}];

const nestedPath = keyPath('message', 'role');
const nestedField: FieldStats = {
  path: nestedPath,
  displayPath: '$.message.role',
  seenRecords: '1',
  validRecordsObserved: '1',
  kinds: { string: '1' },
  missingRecords: '0',
  nullRecords: '0',
  examples: ['assistant'],
  firstSeenOrdinal: '0',
  lastSeenOrdinal: '0',
  confidence: 'sampled',
};

describe('record-query vertical slice', () => {
  it('keeps the default projection when schema arrives before the first row columns', () => {
    const selected = selectedRecordColumns([], [nestedField], { __ordinal: true });
    expect(selected).toBeUndefined();
    const request = buildRecordQueryRequest({
      limit: 100,
      filterColumns: [],
      ...(selected === undefined ? {} : { columns: selected }),
      sort: { columnId: '__ordinal', direction: 'desc' },
    });
    expect(request).not.toHaveProperty('columns');
    expect(request.sort).toEqual({ columnId: '__ordinal', direction: 'desc' });
  });

  it('keeps an explicit all-hidden projection while columns are being restored', () => {
    const selected = selectedRecordColumns([], [nestedField], {
      __ordinal: true,
      [JSON.stringify(nestedPath.tokens)]: false,
    });
    expect(selected).toEqual([]);
    expect(buildRecordQueryRequest({ limit: 100, filterColumns: [], columns: selected! }))
      .toHaveProperty('columns', []);
  });

  it('requests saved nested selections before the first row columns arrive', () => {
    const nestedId = JSON.stringify(nestedPath.tokens);
    expect(selectedRecordColumns([], [nestedField], { [nestedId]: true })
      ?.map((column) => column.id)).toEqual([nestedId]);
  });

  it('restores configured paths without schema samples and replaces only semantic profile columns', () => {
    const nestedId = JSON.stringify(nestedPath.tokens);
    const visibility = { [nestedId]: true, eventKind: true };
    const oldEvent: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const newProfile: ColumnSpec = { id: 'severity', label: 'Severity', source: 'profile' };
    const next = columnsAfterProfileChange([oldEvent], [newProfile], visibility);
    expect(next).toEqual([newProfile, {
      id: nestedId, label: '$.message.role', source: 'record', path: nestedPath,
    }]);
    expect(selectedRecordColumns(next, [], visibility)?.map((column) => column.id)).toEqual([nestedId]);
    expect(recordColumnOptions([], [], visibility)).toEqual([next[1]]);
    expect(selectedRecordColumns([], [], visibility)).toEqual([next[1]]);
    expect(columnsAfterProfileChange(next, [], visibility)).toEqual([next[1]]);
  });

  it('restores only canonical bounded record paths and preserves an unsampled all-hidden choice', () => {
    const invalidIds = [
      'eventKind', '$.message.role', '[]', '[null]', '[{"kind":"key","value":""}]',
      '[{"kind":"index","value":-1}]', '[{"kind":"index","value":1.5}]',
      '[{"kind":"unknown","value":"x"}]', ' [{"kind":"key","value":"status"}]',
      JSON.stringify(keyPath('x'.repeat(260)).tokens),
      JSON.stringify(Array.from({ length: 33 }, () => ({ kind: 'index', value: 0 }))),
    ];
    expect(recordColumnOptions([], [], Object.fromEntries(invalidIds.map((id) => [id, true])))).toEqual([]);
    const nestedId = JSON.stringify(nestedPath.tokens);
    expect(recordColumnOptions([], [], { [nestedId]: false })).toEqual([]);
    expect(selectedRecordColumns([], [], { [nestedId]: false })).toEqual([]);
    expect(selectedRecordColumns([], [{ ...nestedField, path: keyPath('different'), displayPath: '$.different' }],
      { [nestedId]: false })).toEqual([]);
    expect(selectedRecordColumns([], [], { eventKind: false })).toBeUndefined();
    expect(columnsAfterProfileChange(columns, [], { [columns[0]!.id]: false })).toEqual([]);
  });

  it('caps only the requested projection while keeping overflow selections available', () => {
    const visibility = Object.fromEntries(Array.from({ length: MAX_TABLE_COLUMNS + 2 }, (_, index) => [
      JSON.stringify(keyPath('field' + index).tokens), true,
    ]));
    const semantic: ColumnSpec = { id: 'severity', label: 'Severity', source: 'profile' };
    expect(configuredRecordColumns([semantic], [], visibility)).toHaveLength(MAX_TABLE_COLUMNS + 2);
    expect(selectedRecordColumns([semantic], [], visibility)).toHaveLength(MAX_TABLE_COLUMNS - 1);
    const changed = columnsAfterProfileChange([semantic], [], visibility);
    expect(changed).toHaveLength(MAX_TABLE_COLUMNS);
    expect(configuredRecordColumns(changed, [], visibility)).toHaveLength(MAX_TABLE_COLUMNS + 2);
    expect(recordColumnOptions(changed, [], visibility)).toHaveLength(MAX_TABLE_COLUMNS + 2);
  });

  it('offers nested schema leaves and keeps explicit visibility within the column cap', () => {
    const nestedId = JSON.stringify(nestedPath.tokens);
    const malformed: ColumnSpec = { id: 'not-a-path', label: 'Invalid', source: 'record', path: keyPath('other') };
    const candidates = recordColumnCandidates([...columns, malformed], [nestedField]);
    expect(candidates.map((column) => column.id)).toEqual([columns[0]!.id, nestedId]);

    expect(selectedRecordColumns(columns, [nestedField], {
      [columns[0]!.id]: false,
      [nestedId]: true,
    })?.map((column) => column.id)).toEqual([nestedId]);

    const crowded: ColumnSpec[] = Array.from({ length: MAX_TABLE_COLUMNS - 1 }, (_, index) => ({
      id: 'profile-' + index,
      label: 'Profile ' + index,
      source: 'profile',
    }));
    expect(selectedRecordColumns([...crowded, ...columns], [nestedField], {
      [nestedId]: true,
    })?.map((column) => column.id)).toEqual([columns[0]!.id]);
  });

  it('exposes nested schema leaves to structured filter options and predicates', () => {
    const nestedId = JSON.stringify(nestedPath.tokens);
    const filterColumns = recordColumnOptions(columns, [nestedField]);
    expect(filterColumns.map((column) => column.id)).toEqual([columns[0]!.id, nestedId]);

    const filter = buildStructuredFilter({
      columnId: nestedId,
      operator: 'eq',
      value: 'assistant',
      caseSensitive: false,
      selectedColumn: filterColumns.find((column) => column.id === nestedId),
      filterColumns,
    });
    expect(filter).toEqual({
      columnId: nestedId,
      operator: 'eq',
      source: 'record',
      path: nestedPath,
      value: 'assistant',
    });
    expect(buildRecordQueryRequest({ limit: 100, filter: filter!, filterColumns }).predicate).toEqual({
      op: 'compare',
      path: nestedPath,
      cmp: 'eq',
      value: 'assistant',
    });
  });

  it('keeps a first-level type field available alongside profile-derived Event', () => {
    const typePath = keyPath('type');
    const typeField: FieldStats = {
      ...nestedField,
      path: typePath,
      displayPath: '$.type',
    };
    const profileEvent: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const options = recordColumnOptions([profileEvent], [typeField]);

    expect(options.map((column) => column.label)).toEqual(['Event', '$.type']);
    expect(options[1]).toMatchObject({
      id: JSON.stringify(typePath.tokens),
      label: '$.type',
      source: 'record',
      path: typePath,
    });
  });

  it('builds only supported structured filters with captured source and path', () => {
    expect(buildStructuredFilter({
      columnId: columns[0]!.id,
      operator: 'contains',
      value: 'error',
      caseSensitive: true,
      selectedColumn: columns[0],
      filterColumns: columns,
    })).toEqual({
      columnId: columns[0]!.id,
      operator: 'contains',
      source: 'record',
      path: keyPath('status'),
      value: 'error',
      caseSensitive: true,
    });

    expect(buildStructuredFilter({
      columnId: columns[0]!.id,
      operator: 'contains',
      value: '42',
      caseSensitive: false,
      selectedColumn: columns[0],
      filterColumns: columns,
    })).toMatchObject({ operator: 'contains', value: '42' });
    expect(buildStructuredFilter({
      columnId: columns[0]!.id,
      operator: 'kind_is',
      value: 'unexpected',
      caseSensitive: false,
      selectedColumn: columns[0],
      filterColumns: columns,
    })).toBeUndefined();
    expect(buildStructuredFilter({
      columnId: columns[0]!.id,
      operator: 'exists',
      value: 'ignored',
      caseSensitive: false,
      selectedColumn: columns[0],
      filterColumns: columns,
    })).toEqual({
      columnId: columns[0]!.id,
      operator: 'exists',
      source: 'record',
      path: keyPath('status'),
    });
  });

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
