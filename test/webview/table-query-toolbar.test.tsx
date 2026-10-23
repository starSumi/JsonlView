import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ColumnSpec } from '../../src/shared/types';
import { ColumnChooser, type ColumnChooserProps } from '../../src/webview/features/record-query/ColumnChooser';
import { CompactQueryHud } from '../../src/webview/features/record-query/CompactQueryHud';
import { RecordQueryControls, type RecordQueryControlsProps } from '../../src/webview/features/record-query/RecordQueryControls';
import { RowTypeChooser, type RowTypeChooserProps } from '../../src/webview/features/record-query/RowTypeChooser';
import { TableQueryToolbar } from '../../src/webview/features/record-query/TableQueryToolbar';

const profileColumn: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };

function queryProps(overrides: Partial<RecordQueryControlsProps> = {}): RecordQueryControlsProps {
  return {
    query: 'needle',
    searchDisabled: false,
    sortDirection: 'asc',
    descendingDisabled: false,
    descendingDisabledReason: '',
    onSortDirectionChange: vi.fn(),
    onSearchSubmit: vi.fn(),
    onSearchChange: vi.fn(),
    onSearchClear: vi.fn(),
    filterActive: false,
    filters: [],
    filterableColumns: [profileColumn],
    filterColumnId: profileColumn.id,
    filterOperator: 'contains',
    filterOperators: [{ value: 'contains', label: 'contains', needsValue: true }],
    filterValue: '',
    filterCaseSensitive: false,
    onFilterColumnChange: vi.fn(),
    onFilterOperatorChange: vi.fn(),
    onFilterValueChange: vi.fn(),
    onFilterCaseSensitiveChange: vi.fn(),
    onFilterSubmit: vi.fn(),
    onFilterClear: vi.fn(),
    ...overrides,
  };
}

function rowTypes(): Pick<RowTypeChooserProps, 'sources' | 'selection' | 'disabled' | 'onChange'> {
  return { sources: [], selection: undefined, disabled: false, onChange: vi.fn() };
}

function columns(): ColumnChooserProps {
  return {
    columns: [profileColumn],
    schema: [],
    selectedRecordIds: new Set(),
    visibility: {},
    recordColumnLimit: 64,
    schemaComplete: false,
    schemaLoadFailed: false,
    onRetrySchema: vi.fn(),
    onVisibilityChange: vi.fn(),
  };
}

type ToolbarElementProps = { children?: React.ReactNode; className?: string; 'data-query-hud'?: string };

function childrenOf(element: ReactElement<ToolbarElementProps>): ReactElement[] {
  return React.Children.toArray(element.props.children)
    .filter((child): child is ReactElement => React.isValidElement(child));
}

describe('TableQueryToolbar render seam', () => {
  it('keeps the fieldset and child component boundaries observable to shallow callers', () => {
    const onSearchSubmit = vi.fn();
    const query = queryProps({ onSearchSubmit });
    const toolbar = TableQueryToolbar({
      previewStatus: undefined,
      onSaveAs: vi.fn(),
      queryControls: query,
      rowTypes: rowTypes(),
      showColumns: true,
      columns: columns(),
    }) as ReactElement<ToolbarElementProps>;
    const children = childrenOf(toolbar);
    const queryElement = children.find((child) => child.type === RecordQueryControls) as ReactElement<RecordQueryControlsProps> | undefined;
    const rowTypesElement = children.find((child) => child.type === RowTypeChooser) as ReactElement<RowTypeChooserProps> | undefined;
    const columnsElement = children.find((child) => child.type === ColumnChooser) as ReactElement<ColumnChooserProps> | undefined;

    expect(toolbar.type).toBe('fieldset');
    expect(toolbar.props.className).toBe('table-query-toolbar');
    expect(toolbar.props['data-query-hud']).toBe('compact');
    expect(queryElement?.props.query).toBe(query.query);
    expect(queryElement?.props.filterableColumns).toBe(query.filterableColumns);
    expect(queryElement?.props.onSearchSubmit).toBe(onSearchSubmit);
    expect(rowTypesElement?.props.sources).toEqual([]);
    expect(columnsElement?.props.columns).toEqual([profileColumn]);
  });

  it('omits the column chooser in conversation mode without changing the toolbar shell', () => {
    const toolbar = TableQueryToolbar({
      previewStatus: undefined,
      onSaveAs: vi.fn(),
      queryControls: queryProps(),
      rowTypes: rowTypes(),
      showColumns: false,
      columns: columns(),
    }) as ReactElement<ToolbarElementProps>;

    expect(toolbar.props.className).toBe('table-query-toolbar');
    expect(childrenOf(toolbar).some((child) => child.type === ColumnChooser)).toBe(false);
  });

  it('renders the labeled toolbar and preserves the control order', () => {
    const markup = renderToStaticMarkup(React.createElement(TableQueryToolbar, {
      previewStatus: undefined,
      onSaveAs: vi.fn(),
      queryControls: queryProps(),
      rowTypes: rowTypes(),
      showColumns: true,
      columns: columns(),
    }));

    expect(markup).toMatch(/^<fieldset class="table-query-toolbar" data-query-hud="compact" aria-label="Table search and display">/);
    expect(markup).toContain('Search and filters query this file together in bounded scans. Results appear in this view.');
    expect(markup.indexOf('Search records')).toBeLessThan(markup.indexOf('Record order'));
    expect(markup.indexOf('Record order')).toBeLessThan(markup.indexOf('Field filters'));
    expect(markup.indexOf('Field filters')).toBeLessThan(markup.indexOf('Row types'));
    expect(markup.indexOf('Field filters')).toBeLessThan(markup.indexOf('Columns'));
  });

  it('exposes the named HUD seam without adding a second query state owner', () => {
    expect(TableQueryToolbar).toBe(CompactQueryHud);
    const markup = renderToStaticMarkup(React.createElement(CompactQueryHud, {
      previewStatus: undefined,
      onSaveAs: vi.fn(),
      queryControls: queryProps(),
      rowTypes: rowTypes(),
      showColumns: false,
      columns: columns(),
    }));

    expect(markup).toContain('data-query-hud="compact"');
    expect(markup).toContain('aria-label="Field filters"');
    expect(markup).toContain('aria-label="Row types"');
    expect(markup).not.toContain('data-query-draft');
  });
});
