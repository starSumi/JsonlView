import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TopQueryStudio, type TopQueryStudioProps } from '../../src/webview/features/record-query/TopQueryStudio';

function render(overrides: Partial<TopQueryStudioProps> = {}): string {
  const props: TopQueryStudioProps = {
    open: false,
    queryControls: {
      query: '', searchDisabled: false, sortDirection: 'asc', descendingDisabled: false,
      descendingDisabledReason: '', onSortDirectionChange: vi.fn(), onSearchSubmit: vi.fn(),
      onSearchChange: vi.fn(), onSearchClear: vi.fn(), filterActive: false, filterableColumns: [],
      filterColumnId: '', filterOperator: 'contains', filterOperators: [{ value: 'contains', label: 'Contains', needsValue: true }],
      filterValue: '', filterCaseSensitive: false, onFilterColumnChange: vi.fn(), onFilterOperatorChange: vi.fn(),
      onFilterValueChange: vi.fn(), onFilterCaseSensitiveChange: vi.fn(), onFilterSubmit: vi.fn(), onFilterClear: vi.fn(),
    },
    history: [], pending: false, disabled: false, onToggle: vi.fn(), onClose: vi.fn(), onRun: vi.fn(), onCancel: vi.fn(), onHistorySelect: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(TopQueryStudio, props));
}

describe('Top Query Studio projection', () => {
  it('keeps the closed state free of studio controls', () => {
    const markup = render();
    expect(markup).toContain('data-query-studio-toggle');
    expect(markup).not.toContain('data-query-studio=""');
  });

  it('exposes a bounded expanded region with run, cancel and session history actions', () => {
    const markup = render({
      open: true,
      pending: true,
      history: [{ id: 'deadbeef', query: 'error', filters: [], label: 'error' }],
    });
    expect(markup).toContain('data-query-studio="true"');
    expect(markup).toContain('aria-label="Expanded query studio"');
    expect(markup).toContain('Run query');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('error');
  });
});
