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
  it('shows physical line direction as one toolbar mode', () => {
    const markup = render({ sortDirection: 'desc' });
    expect(markup).toContain('role="group" aria-label="Record order"');
    expect(markup).toMatch(/aria-label="First line first" aria-pressed="false"/);
    expect(markup).toMatch(/aria-label="Last line first" aria-pressed="true"/);
  });

  it('exposes the indexing reason when reverse order is unavailable', () => {
    const markup = render({
      descendingDisabled: true,
      descendingDisabledReason: 'Available when indexing completes',
    });
    expect(markup).toContain('title="Available when indexing completes"');
    expect(markup).toContain('aria-description="Available when indexing completes" disabled=""');
    expect(markup).toMatch(/aria-label="First line first" aria-pressed="true"/);
    expect(markup).toMatch(/aria-label="First line first" aria-pressed="true" aria-description="Available when indexing completes" disabled=""/);
  });
});
