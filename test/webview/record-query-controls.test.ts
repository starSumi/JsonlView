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
  it('keeps the search form without a second Play action beside the Studio trigger', () => {
    const markup = render();
    expect(markup).toContain('<form id="record-search-form" class="search-box" role="search"');
    expect(markup).toMatch(/<svg[^>]*class="lucide lucide-search"/);
    expect(markup).not.toContain('lucide-play');
    expect(markup).not.toContain('aria-label="Run query"');
    expect(render({ searchDisabled: true })).toMatch(/aria-description="Search and filters[^>]*disabled=""/);
  });

  it('shows the active order with a stable toggle name and the next action in its tooltip', () => {
    const ascendingMarkup = render({ sortDirection: 'asc' });
    expect(ascendingMarkup).toMatch(/<button type="button" class="row-order-control" data-direction="asc"[^>]*aria-label="Descending row order; last line first"[^>]*aria-pressed="false"/);
    expect(ascendingMarkup).toContain('title="Sort rows descending; last line first"');
    expect(ascendingMarkup).not.toContain('type="radio"');
    expect(ascendingMarkup).toContain('lucide-arrow-up-narrow-wide');

    const markup = render({ sortDirection: 'desc' });
    expect(markup).toMatch(/<button type="button" class="row-order-control" data-direction="desc"[^>]*aria-label="Descending row order; last line first"[^>]*aria-pressed="true"/);
    expect(markup).toContain('title="Sort rows ascending; first line first"');
    expect(markup).toContain('lucide-arrow-down-wide-narrow');
  });

  it('disables the toggle with the indexing reason when reverse order is unavailable', () => {
    const markup = render({
      descendingDisabled: true,
      descendingDisabledReason: 'Available when indexing completes',
    });
    expect(markup).toMatch(/<button type="button" class="row-order-control" data-direction="asc"[^>]*disabled=""/);
    expect(markup).toContain('aria-description="Available when indexing completes"');
    expect(markup).toContain('title="Available when indexing completes"');
  });

  it('disables the order toggle when the source cannot be searched', () => {
    const markup = render({ searchDisabled: true });
    expect(markup).toMatch(/<button type="button" class="row-order-control"[^>]*disabled=""/);
  });

  it('keeps the return to ascending available when descending becomes unavailable', () => {
    const markup = render({ sortDirection: 'desc', descendingDisabled: true });
    const toggle = markup.match(/<button type="button" class="row-order-control"[^>]*>/)?.[0];
    expect(toggle).toContain('title="Sort rows ascending; first line first"');
    expect(toggle).not.toContain('disabled=');
  });

  it('preserves native details disclosure with scrollable fields and reachable actions', () => {
    const markup = render({ filterActive: true, filterableColumns: [{ id: 'status', label: 'Status', source: 'profile' }], filterColumnId: 'status' });
    expect(markup).toContain('<details class="filter-menu"><summary');
    expect(markup).toContain('class="filter-fields"');
    expect(markup).toMatch(/<\/div><div class="filter-actions"><button type="submit">Add condition<\/button><button type="button">Clear fields/);
    expect(markup).toContain('aria-label="Field filters"');
    expect(markup).toContain('lucide-filter');
    expect(markup).not.toContain('lucide-circle-chevron-down');
    expect(markup).toContain('Match all field conditions, the search, and any selected row type.');
    expect(markup).not.toContain('role="menu"');
  });

  it('shows each applied condition with its own remove action', () => {
    const markup = render({ filterActive: true,
      filters: [{ columnId: 'status', source: 'profile', operator: 'eq', value: 'ok' },
        { columnId: 'actor', source: 'profile', operator: 'eq', value: 'assistant' }],
      filterableColumns: [{ id: 'status', label: 'Status', source: 'profile' },
        { id: 'actor', label: 'Actor', source: 'profile' }], filterColumnId: 'status' });
    expect(markup).toContain('aria-description="2 field conditions applied"');
    expect(markup).toContain('aria-label="Remove condition 1"');
    expect(markup).toContain('aria-label="Remove condition 2"');
    expect(markup).toContain('Status eq &quot;ok&quot;');
    expect(markup).toContain('Actor eq &quot;assistant&quot;');
  });

  it('combines field and sampled row-type forms without nesting them or adding a second disclosure', () => {
    const column = { id: 'eventKind', label: 'Event', source: 'profile' as const };
    const markup = render({ rowTypes: {
      sources: [{ column, values: ['message', 'tool_call'], sampled: true }],
      selection: { column, values: ['message'] }, disabled: true, onChange: vi.fn(),
    } });
    expect(markup.match(/<details /g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Filters"');
    expect(markup).toContain('aria-description="0 field conditions applied; 1 row types selected"');
    expect(markup).toContain('class="row-type-filter-fields"');
    expect(markup).toContain('aria-label="Add exact record type"');
    expect(markup).toContain('<fieldset disabled=""><legend>Event</legend>');
    const rowTypeStart = markup.indexOf('class="row-type-filter-fields"');
    expect(markup.lastIndexOf('</form>', rowTypeStart)).toBeGreaterThan(markup.indexOf('class="field-filter-form"'));
  });
});
