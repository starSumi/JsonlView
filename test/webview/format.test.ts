import { describe, expect, it } from 'vitest';
import {
  buildTreePreview,
  columnGridTemplate,
  formatBytes,
  schemaRecordColumns,
  visibleColumns,
} from '../../src/webview/format';
import { validateWebviewRequest } from '../../src/extension/message-validation';
import {
  displayFieldPath,
  keyPath,
  MAX_TABLE_COLUMNS,
  PROTOCOL_VERSION,
  type FieldPath,
  type FieldStats,
} from '../../src/shared/types';

function schemaField(path: FieldPath): FieldStats {
  return {
    path,
    displayPath: displayFieldPath(path),
    seenRecords: '1',
    validRecordsObserved: '1',
    kinds: { string: '1' },
    missingRecords: '0',
    nullRecords: '0',
    examples: [],
    firstSeenOrdinal: '0',
    lastSeenOrdinal: '0',
    confidence: 'sampled',
  };
}

describe('webview formatting selectors', () => {
  it('does not expose the root record as a selectable schema column', () => {
    const root: FieldPath = { tokens: [] };
    const columns = schemaRecordColumns([schemaField(root), schemaField(keyPath('message', 'role'))]);

    expect(columns.map((column) => column.label)).toEqual(['$.message.role']);
    expect(columns.some((column) => column.label === '$')).toBe(false);
  });

  it('builds distinct record columns for nested schema paths and removes repeated paths', () => {
    const first = keyPath('payload', 'id');
    const second = keyPath('meta', 'id');
    const indexed: FieldPath = {
      tokens: [...keyPath('items').tokens, { kind: 'index', value: 0 }, ...keyPath('id').tokens],
    };

    const columns = schemaRecordColumns([
      schemaField(first), schemaField(second), schemaField(first), schemaField(indexed),
    ]);

    expect(columns.map((column) => [column.id, column.label])).toEqual([
      [JSON.stringify(first.tokens), '$.payload.id'],
      [JSON.stringify(second.tokens), '$.meta.id'],
      [JSON.stringify(indexed.tokens), '$.items[0].id'],
    ]);
    expect(columns.every((column) => column.source === 'record')).toBe(true);
  });

  it('caps schema columns and skips paths that cannot fit the rows protocol', () => {
    const tooDeep: FieldPath = { tokens: Array.from({ length: 33 }, () => ({ kind: 'key', value: 'a' })) };
    const tooLong = keyPath('a'.repeat(250));
    const fields = Array.from(
      { length: MAX_TABLE_COLUMNS + 10 },
      (_, index) => schemaField(keyPath(`field${String(index)}`)),
    );

    const columns = schemaRecordColumns([schemaField(tooDeep), schemaField(tooLong), ...fields]);
    expect(columns).toHaveLength(MAX_TABLE_COLUMNS);
    expect(columns[0]?.id).toBe(JSON.stringify(fields[0]!.path.tokens));
    expect(columns.at(-1)?.id).toBe(JSON.stringify(fields[MAX_TABLE_COLUMNS - 1]!.path.tokens));
    expect(schemaRecordColumns(fields, 2).map((column) => column.label)).toEqual(['$.field0', '$.field1']);
  });

  it('offers schema candidates beyond the 64-column projection budget', () => {
    const fields = Array.from({ length: 300 }, (_, index) => schemaField(keyPath(`field${String(index)}`)));

    const candidates = schemaRecordColumns(fields, 250);
    expect(candidates).toHaveLength(250);
    expect(candidates[64]?.id).toBe(JSON.stringify(fields[64]!.path.tokens));
    expect(validateWebviewRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'GET_ROWS',
      documentId: 'document',
      generation: 'generation',
      requestId: 'selected-nested-field',
      payload: { limit: 1, columns: [candidates[64]] },
    }).ok).toBe(true);
    expect(schemaRecordColumns(fields, 300)).toHaveLength(250);
  });

  it('keeps an ordinal column even when every data column is hidden', () => {
    const columns = [{ id: 'message', label: 'Message', source: 'record' as const }];
    expect(visibleColumns(columns, { __ordinal: false, message: false }).map((column) => column.id)).toEqual(['__ordinal']);
    expect(columnGridTemplate(visibleColumns(columns, {}))).toContain('88px');
  });

  it('deduplicates the legacy engine ordinal column', () => {
    const columns = [
      { id: '$ordinal', label: 'Ordinal', source: 'system' as const },
      { id: 'message', label: 'Message', source: 'record' as const },
    ];
    expect(visibleColumns(columns, {}).map((column) => column.id)).toEqual(['__ordinal', 'message']);
  });

  it('keeps ordinal fixed while applying a persisted user column order', () => {
    const columns = [
      { id: 'first', label: 'First', source: 'record' as const },
      { id: 'second', label: 'Second', source: 'record' as const },
    ];
    expect(visibleColumns(columns, { __ordinal: false }, ['second', '__ordinal', 'first']).map((column) => column.id))
      .toEqual(['__ordinal', 'second', 'first']);
  });

  it('emits a fixed track for a user-resized column', () => {
    const columns = [
      { id: 'message', label: 'Message', source: 'record' as const },
      { id: 'level', label: 'Level', source: 'record' as const },
    ];
    const template = columnGridTemplate(columns, { message: 320 });
    expect(template).toContain('320px');
    expect(template).toContain('minmax(180px, 2fr)');
  });

  it('caps detail tree expansion by node and child budgets', () => {
    const preview = buildTreePreview({ values: Array.from({ length: 1000 }, (_, index) => index) }, 20, 8, 5);
    expect(preview.length).toBeLessThanOrEqual(20);
    expect(preview.some((row) => row.preview.includes('more'))).toBe(true);
  });

  it('walks only bounded children for a very large sparse array', () => {
    const value = new Array(1_000_000) as unknown[];
    value[0] = 'first';
    value[1] = 'second';

    const rows = buildTreePreview(value, 10, 2, 2);

    expect(rows).toHaveLength(4);
    expect(rows[0]?.preview).toBe('array (1000000)');
    expect(rows.at(-1)?.preview).toBe('999998 more');
  });

  it('formats decimal byte strings without changing their stored representation', () => {
    expect(formatBytes('280605706')).toBe('267.6 MB');
  });
});
