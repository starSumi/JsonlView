import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MAX_TABLE_COLUMNS, keyPath, type ColumnSpec } from '../../src/shared/types';
import { ColumnChooser, RowTypeChooser, rowTypeSources } from '../../src/webview/features/record-query';
import { configuredRecordColumns, recordColumnOptions, selectedRecordColumns } from '../../src/webview/features/record-query/model';

describe('independent table display and row-type disclosures', () => {
  it('labels columns as display choices and keeps an existing long column visible', () => {
    const path = keyPath('payload', 'text');
    const record: ColumnSpec = { id: JSON.stringify(path.tokens), label: '$.payload.text', source: 'record', path };
    const markup = renderToStaticMarkup(React.createElement(ColumnChooser, {
      columns: [{ id: 'eventKind', label: 'Event', source: 'profile' }, record],
      schema: [], selectedRecordIds: new Set([record.id]), visibility: {}, recordColumnLimit: 20,
      schemaComplete: false, schemaLoadFailed: false, onRetrySchema: vi.fn(), onVisibilityChange: vi.fn(),
    }));
    expect(markup).toContain('aria-label="Columns"');
    expect(markup).toContain('Controls this table’s display. Rows and filters stay the same.');
    expect(markup).toContain('<legend>Selected record fields</legend>');
    expect(markup).toContain('checked=""/><span title="$.payload.text"');
    expect(markup).not.toContain('aria-label="Row types"');
  });

  it('defaults to semantic Event even when raw top-level type is also available', () => {
    const path = keyPath('type');
    const sources = rowTypeSources([{ id: 'eventKind', label: 'Event', source: 'profile' }], [{
      path, displayPath: '$.type', kinds: { string: '1' }, examples: ['response_item'], seenRecords: '1',
      validRecordsObserved: '1', missingRecords: '0', nullRecords: '0', firstSeenOrdinal: '0',
      lastSeenOrdinal: '0', confidence: 'sampled',
    }], []);
    const markup = renderToStaticMarkup(React.createElement(RowTypeChooser, {
      sources, disabled: false, onChange: vi.fn(),
    }));
    expect(markup).toContain('aria-label="Row types"');
    expect(markup).toContain('<option value="eventKind" selected="">Event category (profile)</option>');
    expect(markup).toContain('Match any selected type, and match the search and all field filters.');
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain('Add exact record type');
  });

  it('keeps unsampled configured fields checked and removable beyond the projection limit', () => {
    const visibility = Object.fromEntries(Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, index) => [
      JSON.stringify(keyPath('field' + index).tokens), true,
    ]));
    const columns = recordColumnOptions([], [], visibility);
    const selectedRecordIds = new Set(configuredRecordColumns([], [], visibility)?.map((column) => column.id));
    expect(selectedRecordColumns([], [], visibility)).toHaveLength(MAX_TABLE_COLUMNS);
    const markup = renderToStaticMarkup(React.createElement(ColumnChooser, {
      columns, schema: [], selectedRecordIds, visibility, recordColumnLimit: MAX_TABLE_COLUMNS,
      schemaComplete: false, schemaLoadFailed: false, onRetrySchema: vi.fn(), onVisibilityChange: vi.fn(),
    }));
    expect(markup).toContain('<legend>Selected record fields</legend>');
    expect(markup).toContain('checked=""/><span title="$.field' + MAX_TABLE_COLUMNS + '"');
    expect(markup.match(/checked=""/g)).toHaveLength(MAX_TABLE_COLUMNS + 2);
    expect(markup.match(/disabled=""/g)).toHaveLength(1); // Only the fixed ordinal.
    const overflowId = JSON.stringify(keyPath('field' + MAX_TABLE_COLUMNS).tokens);
    expect(recordColumnOptions([], [], { ...visibility, [overflowId]: false }).map((column) => column.id))
      .not.toContain(overflowId);
  });
});
