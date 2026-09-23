import React from 'react';
import { Filter, Search, X } from 'lucide-react';
import type { ColumnSpec, RowFilterOperator } from '../../../shared/types';

export interface FilterOperatorOption {
  value: RowFilterOperator;
  label: string;
  needsValue: boolean;
}

export interface RecordQueryControlsProps {
  query: string;
  searchDisabled: boolean;
  onSearchSubmit: () => void;
  onSearchChange: (query: string) => void;
  onSearchClear: () => void;
  filterActive: boolean;
  filterableColumns: readonly ColumnSpec[];
  filterColumnId: string;
  filterOperator: RowFilterOperator;
  filterOperators: readonly FilterOperatorOption[];
  filterValue: string;
  filterCaseSensitive: boolean;
  onFilterColumnChange: (columnId: string) => void;
  onFilterOperatorChange: (operator: RowFilterOperator) => void;
  onFilterValueChange: (value: string) => void;
  onFilterCaseSensitiveChange: (enabled: boolean) => void;
  onFilterSubmit: () => void;
  onFilterClear: () => void;
}

export function RecordQueryControls({
  query,
  searchDisabled,
  onSearchSubmit,
  onSearchChange,
  onSearchClear,
  filterActive,
  filterableColumns,
  filterColumnId,
  filterOperator,
  filterOperators,
  filterValue,
  filterCaseSensitive,
  onFilterColumnChange,
  onFilterOperatorChange,
  onFilterValueChange,
  onFilterCaseSensitiveChange,
  onFilterSubmit,
  onFilterClear,
}: RecordQueryControlsProps): React.JSX.Element {
  const needsValue = !['exists', 'is_null'].includes(filterOperator);
  const supportsCaseSensitive = ['contains', 'starts_with', 'ends_with'].includes(filterOperator);

  return (
    <>
      <form
        className="search-box"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          onSearchSubmit();
        }}
      >
        <Search size={14} aria-hidden />
        <input
          value={query}
          placeholder="Search records"
          aria-label="Search records"
          disabled={searchDisabled}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {query ? (
          <button type="button" className="search-clear" title="Clear search" aria-label="Clear search" onClick={onSearchClear}>
            <X size={13} aria-hidden />
          </button>
        ) : null}
      </form>
      <details className="filter-menu">
        <summary className={`icon-button${filterActive ? ' is-active' : ''}`} title="Filter records" aria-label="Filter records">
          <Filter size={15} aria-hidden />
        </summary>
        <form
          className="filter-popover"
          onSubmit={(event) => {
            event.preventDefault();
            onFilterSubmit();
          }}
        >
          <label>
            <span>Field</span>
            <select
              value={filterColumnId}
              disabled={filterableColumns.length === 0}
              onChange={(event) => onFilterColumnChange(event.target.value)}
            >
              {filterableColumns.map((column) => <option value={column.id} key={column.id}>{column.label}</option>)}
            </select>
          </label>
          <label>
            <span>Match</span>
            <select value={filterOperator} onChange={(event) => onFilterOperatorChange(event.target.value as RowFilterOperator)}>
              {filterOperators.map((operator) => <option value={operator.value} key={operator.value}>{operator.label}</option>)}
            </select>
          </label>
          {needsValue ? (
            <label>
              <span>Value</span>
              <input
                value={filterValue}
                aria-label="Filter value"
                placeholder={filterOperator === 'kind_is' ? 'string, number, object...' : 'value'}
                onChange={(event) => onFilterValueChange(event.target.value)}
              />
            </label>
          ) : null}
          {supportsCaseSensitive ? (
            <label className="filter-check">
              <input type="checkbox" checked={filterCaseSensitive} onChange={(event) => onFilterCaseSensitiveChange(event.target.checked)} />
              <span>Case sensitive</span>
            </label>
          ) : null}
          <div className="filter-actions">
            <button type="submit" disabled={!filterColumnId || filterableColumns.length === 0}>Apply</button>
            <button type="button" onClick={onFilterClear} disabled={!filterActive}>Clear</button>
          </div>
          <small>Scans a bounded source window; limited results are marked.</small>
        </form>
      </details>
    </>
  );
}
