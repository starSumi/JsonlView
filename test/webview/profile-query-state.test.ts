import { describe, expect, it } from 'vitest';
import type { ColumnSpec, RowFilter, RowSort } from '../../src/shared/types';
import { keyPath } from '../../src/shared/types';
import { reconcileProfileQueryState } from '../../src/webview/features/record-query/profile-query-state';

const profileColumn: ColumnSpec = { id: 'summary', label: 'Summary', source: 'profile' };
const recordPath = keyPath('requestId');
const recordColumn: ColumnSpec = {
  id: JSON.stringify(recordPath.tokens),
  label: 'Request ID',
  source: 'record',
  path: recordPath,
};

describe('reconcileProfileQueryState', () => {
  it.each(['__ordinal', '$ordinal'])('preserves physical ordinal sort %s without profile columns', (columnId) => {
    const sort: RowSort = { columnId, direction: 'desc' };

    const reconciled = reconcileProfileQueryState(sort, undefined, [], []);

    expect(reconciled.sort).toBe(sort);
  });

  it('retains valid encoded record paths without column metadata and rejects malformed ids', () => {
    const sort: RowSort = { columnId: recordColumn.id, direction: 'asc' };
    const malformed: RowSort = { columnId: '[{"kind":"index","value":-1}]', direction: 'asc' };
    const recordFilter: RowFilter = {
      columnId: recordColumn.id,
      source: 'record',
      path: recordPath,
      operator: 'exists',
    };

    const reconciled = reconcileProfileQueryState(sort, recordFilter, [], []);

    expect(reconciled.sort).toBe(sort);
    expect(reconciled.filter).toBe(recordFilter);
    expect(reconcileProfileQueryState(malformed, undefined, [], []).sort).toBeUndefined();
  });

  it('retains record intent when a field disappears but drops it when the profile shadows the id', () => {
    const sort: RowSort = { columnId: recordColumn.id, direction: 'desc' };
    const filter: RowFilter = {
      columnId: recordColumn.id,
      source: 'record',
      path: recordPath,
      operator: 'contains',
      value: 'req-',
    };

    const removed = reconcileProfileQueryState(sort, filter, [recordColumn], []);
    const shadowingProfileColumn: ColumnSpec = { id: recordColumn.id, label: 'Request ID', source: 'profile' };
    const shadowed = reconcileProfileQueryState(sort, filter, [recordColumn], [shadowingProfileColumn]);

    expect(removed.sort).toBe(sort);
    expect(removed.filter).toBe(filter);
    expect(shadowed.sort).toBeUndefined();
    expect(shadowed.filter).toBeUndefined();
  });

  it('retains profile intent only when the new profile still owns the field', () => {
    const sort: RowSort = { columnId: profileColumn.id, direction: 'asc' };
    const filter: RowFilter = {
      columnId: profileColumn.id,
      source: 'profile',
      operator: 'eq',
      value: 'ready',
    };

    const unchanged = reconcileProfileQueryState(sort, filter, [profileColumn], [profileColumn]);
    const removed = reconcileProfileQueryState(sort, filter, [profileColumn], []);
    const shadowingRecordColumn: ColumnSpec = {
      id: profileColumn.id,
      label: 'Summary',
      source: 'record',
      path: keyPath('summary'),
    };
    const shadowed = reconcileProfileQueryState(sort, filter, [profileColumn], [shadowingRecordColumn]);

    expect(unchanged.sort).toBe(sort);
    expect(unchanged.filter).toBe(filter);
    expect(removed.sort).toBeUndefined();
    expect(removed.filter).toBeUndefined();
    expect(shadowed.sort).toBeUndefined();
    expect(shadowed.filter).toBeUndefined();
  });
});
