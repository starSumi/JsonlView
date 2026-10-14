import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RecordQueryControls, type RecordQueryControlsProps } from '../../src/webview/features/record-query/RecordQueryControls';

function render(overrides: Partial<RecordQueryControlsProps> = {}): string {
  return renderToStaticMarkup(React.createElement(RecordQueryControls, {
    query: '',
    searchDisabled: false,
    sortDirection: 'asc',
    descendingDisabled: false,
    descendingDisabledReason: '',
    onSortDirectionChange: vi.fn(),
    onSearchSubmit: vi.fn(),
    onSearchChange: vi.fn(),
    onSearchClear: vi.fn(),
    filterActive: false,
    filterableColumns: [],
    filterColumnId: '',
    filterOperator: 'contains',
    filterOperators: [{ value: 'contains', label: 'Contains', needsValue: true }],
    filterValue: '',
    filterCaseSensitive: false,
    onFilterColumnChange: vi.fn(),
    onFilterOperatorChange: vi.fn(),
    onFilterValueChange: vi.fn(),
    onFilterCaseSensitiveChange: vi.fn(),
    onFilterSubmit: vi.fn(),
    onFilterClear: vi.fn(),
    ...overrides,
  }));
}

describe('record order controls', () => {
  it('shows physical line direction as one explicit sort toggle', () => {
    const ascendingMarkup = render({ sortDirection: 'asc' });
    expect(ascendingMarkup).toContain('<fieldset class="row-order-control" aria-label="Record order"');
    expect(ascendingMarkup).toContain('aria-label="Toggle row order"');
    expect(ascendingMarkup).toContain('aria-pressed="false"');
    expect(ascendingMarkup).toContain('title="Rows: first line first; activate for last line first"');

    const markup = render({ sortDirection: 'desc' });
    expect(markup).toContain('<fieldset class="row-order-control" aria-label="Record order"');
    expect(markup).toContain('aria-label="Toggle row order"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('title="Rows: last line first; activate for first line first"');
    expect(markup).not.toContain('aria-label="First line first"');
    expect(markup).not.toContain('aria-label="Last line first"');
  });

  it('exposes the indexing reason when reverse order is unavailable', () => {
    const markup = render({
      descendingDisabled: true,
      descendingDisabledReason: 'Available when indexing completes',
    });
    expect(markup).toContain('title="Available when indexing completes"');
    expect(markup).toContain('aria-description="Available when indexing completes" disabled=""');
    expect(markup).toContain('aria-label="Toggle row order"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it('preserves native details disclosure with scrollable fields and reachable actions', () => {
    const markup = render({ filterActive: true, filterableColumns: [{ id: 'status', label: 'Status', source: 'profile' }], filterColumnId: 'status' });
    expect(markup).toContain('<details class="filter-menu"><summary');
    expect(markup).toContain('class="filter-fields"');
    expect(markup).toMatch(/<\/div><div class="filter-actions"><button type="submit">Add condition<\/button><button type="button">Clear fields/);
    expect(markup).toContain('aria-label="Field filters"');
    expect(markup).toContain('Match all field conditions, the search, and any selected row type.');
    expect(markup).not.toContain('role="menu"');
  });

  it('shows each applied condition with its own remove action', () => {
    const markup = render({ filterActive: true,
      filters: [{ columnId: 'status', source: 'profile', operator: 'eq', value: 'ok' },
        { columnId: 'actor', source: 'profile', operator: 'eq', value: 'assistant' }],
      filterableColumns: [{ id: 'status', label: 'Status', source: 'profile' },
        { id: 'actor', label: 'Actor', source: 'profile' }], filterColumnId: 'status' });
    expect(markup).toContain('Field filters (2)');
    expect(markup).toContain('aria-label="Remove condition 1"');
    expect(markup).toContain('aria-label="Remove condition 2"');
    expect(markup).toContain('Status eq &quot;ok&quot;');
    expect(markup).toContain('Actor eq &quot;assistant&quot;');
  });
});
