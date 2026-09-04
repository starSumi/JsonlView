import { describe, expect, it } from 'vitest';
import { buildTreePreview, columnGridTemplate, formatBytes, visibleColumns } from '../../src/webview/format';

describe('webview formatting selectors', () => {
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
    expect(formatBytes('123456789')).toBe('117.7 MB');
  });
});
