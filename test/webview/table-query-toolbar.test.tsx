import React, { type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ColumnSpec } from '../../src/shared/types';
import { ColumnChooser, type ColumnChooserProps } from '../../src/webview/features/record-query/ColumnChooser';
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

function childrenOf(element: ReactElement<{ children?: React.ReactNode }>): ReactElement[] {
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
    }) as ReactElement<{ children?: React.ReactNode; className?: string }>;
    const children = childrenOf(toolbar);
    const queryElement = children.find((child) => child.type === RecordQueryControls) as ReactElement<RecordQueryControlsProps> | undefined;
    const rowTypesElement = children.find((child) => child.type === RowTypeChooser) as ReactElement<RowTypeChooserProps> | undefined;
    const columnsElement = children.find((child) => child.type === ColumnChooser) as ReactElement<ColumnChooserProps> | undefined;

    expect(toolbar.type).toBe('fieldset');
    expect(toolbar.props.className).toBe('table-query-toolbar');
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
    }) as ReactElement<{ children?: React.ReactNode; className?: string }>;

    expect(toolbar.props.className).toBe('table-query-toolbar');
    expect(childrenOf(toolbar).some((child) => child.type === ColumnChooser)).toBe(false);
  });
});
