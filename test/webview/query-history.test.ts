import { describe, expect, it } from 'vitest';
import type { RowFilter } from '../../src/shared/types';
import { addQueryHistory, MAX_QUERY_HISTORY_ENTRIES } from '../../src/webview/features/record-query/query-history';
import { createInitialState, toPersistedState } from '../../src/webview/state';

const statusFilter: RowFilter = { columnId: 'status', source: 'profile', operator: 'eq', value: 'ready' };

describe('session query history', () => {
  it('skips empty entries and keeps newest entries first with a hard cap', () => {
    let history = addQueryHistory([], '', []);
    expect(history).toEqual([]);
    for (let index = 0; index < MAX_QUERY_HISTORY_ENTRIES + 3; index += 1) {
      history = addQueryHistory(history, `query-${index}`, []);
    }
    expect(history).toHaveLength(MAX_QUERY_HISTORY_ENTRIES);
    expect(history[0]?.query).toBe('query-12');
    expect(history.at(-1)?.query).toBe('query-3');
  });

  it('deduplicates by canonical query and bounded filters without time-based ids', () => {
    const first = addQueryHistory([], ' status ', [statusFilter]);
    const duplicate = addQueryHistory(first, ' status ', [{ ...statusFilter }]);
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toEqual(first[0]);
    expect(duplicate[0]?.id).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('canonicalizes filter order without locale-sensitive comparison', () => {
    const otherFilter: RowFilter = { columnId: 'actor', source: 'record', operator: 'contains', value: 'agent' };
    const first = addQueryHistory([], 'query', [statusFilter, otherFilter]);
    const reordered = addQueryHistory(first, 'query', [otherFilter, statusFilter]);
    expect(reordered).toHaveLength(1);
    expect(reordered[0]).toEqual(first[0]);
  });

  it('keeps the history session-local and applies byte/field budgets', () => {
    const entry = addQueryHistory([], 'x'.repeat(2_000), [{
      ...statusFilter,
      path: { tokens: [{ kind: 'key', value: 'a'.repeat(1_000) }] },
    }]);
    expect(entry).toHaveLength(1);
    expect(entry[0]?.query).toHaveLength(1_024);
    expect(entry[0]?.filters[0]?.path?.tokens[0]?.value).toHaveLength(256);
    expect(JSON.stringify(entry)).not.toContain('vscode.setState');
  });

  it('does not add the session history to the persisted workspace contract', () => {
    const persisted = toPersistedState(createInitialState());
    expect(Object.keys(persisted)).not.toContain('queryHistory');
    expect(Object.keys(persisted)).not.toContain('history');
  });
});
