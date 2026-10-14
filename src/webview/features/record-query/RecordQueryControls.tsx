import type React from 'react';
import { useRef, useState } from 'react';
import { ArrowDownNarrowWide, ArrowDownWideNarrow, Filter, Search, X } from 'lucide-react';
import type { ColumnSpec, RowFilter, RowFilterOperator, SortDirection } from '../../../shared/types';
import { useLightDismiss } from '../../use-light-dismiss';
import { useViewportPopover } from '../../use-viewport-popover';
import { describeFieldFilter, MAX_FIELD_FILTERS } from './query-selection';

export interface FilterOperatorOption {
  value: RowFilterOperator;
  label: string;
  needsValue: boolean;
}

export interface RecordQueryControlsProps {
  query: string;
  searchDisabled: boolean;
  sortDirection: SortDirection;
  descendingDisabled: boolean;
  descendingDisabledReason: string;
  onSortDirectionChange: (direction: SortDirection) => void;
  onSearchSubmit: () => void;
  onSearchChange: (query: string) => void;
  onSearchClear: () => void;
  filterActive: boolean;
  filters?: readonly RowFilter[];
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
  onFilterRemove?: (index: number) => void;
}

export function RecordQueryControls({
  query,
  searchDisabled,
  sortDirection,
  descendingDisabled,
  descendingDisabledReason,
  onSortDirectionChange,
  onSearchSubmit,
  onSearchChange,
  onSearchClear,
  filterActive,
  filters = [],
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
  onFilterRemove,
}: RecordQueryControlsProps): React.JSX.Element {
  const filterMenuRef = useRef<HTMLDetailsElement>(null);
  useLightDismiss(filterMenuRef);
  useViewportPopover(filterMenuRef);
  const [fieldSearch, setFieldSearch] = useState('');
  const term = fieldSearch.trim().toLocaleLowerCase();
  const matchingFields = filterableColumns.filter((column) => column.label.toLocaleLowerCase().includes(term));
  const displayedFields = matchingFields.slice(0, 50);
  const selectedColumn = filterableColumns.find((column) => column.id === filterColumnId);
  if (selectedColumn !== undefined && !displayedFields.some((column) => column.id === filterColumnId)) displayedFields.unshift(selectedColumn);
  const needsValue = !['exists', 'is_null'].includes(filterOperator);
  const supportsCaseSensitive = ['contains', 'starts_with', 'ends_with'].includes(filterOperator);
  const rowOrderTitle = descendingDisabled
    ? descendingDisabledReason
    : sortDirection === 'asc'
      ? 'Rows: first line first; activate for last line first'
      : 'Rows: last line first; activate for first line first';

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: This form both submits the table query and provides its search landmark. */}
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
          aria-description="Search and filters query the current file together in bounded scans; results appear in this table."
          disabled={searchDisabled}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {query ? (
          <button type="button" className="search-clear" title="Clear search" aria-label="Clear search" onClick={onSearchClear}>
            <X size={13} aria-hidden />
          </button>
        ) : null}
      </form>
      <fieldset
        className="row-order-control"
        aria-label="Record order"
        title={descendingDisabled ? descendingDisabledReason : undefined}
      >
        <button
          type="button"
          className="icon-button"
          title={rowOrderTitle}
          aria-label="Toggle row order"
          aria-pressed={sortDirection === 'desc'}
          aria-description={descendingDisabled ? descendingDisabledReason : undefined}
          disabled={descendingDisabled}
          onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
        >
          {sortDirection === 'asc'
            ? <ArrowDownNarrowWide size={15} aria-hidden />
            : <ArrowDownWideNarrow size={15} aria-hidden />}
        </button>
      </fieldset>
      <details className="filter-menu" ref={filterMenuRef}>
        <summary className={`query-tool-button${filterActive ? ' is-active' : ''}`} title="Field filters: match all conditions" aria-label="Field filters">
          <Filter size={15} aria-hidden /><span>Field filters{filters.length ? ` (${filters.length})` : ''}</span>
        </summary>
        <form
          className="filter-popover"
          data-popover-width="340"
          data-popover-height="480"
          onSubmit={(event) => {
            event.preventDefault();
            onFilterSubmit();
          }}
        >
          <strong>Field filters</strong>
          <small>Match all field conditions, the search, and any selected row type.</small>
          {filters.length > 0 ? <ul className="applied-filters" aria-label="Applied field conditions">
            {filters.map((filter, index) => <li key={JSON.stringify(filter)}>
              <span title={describeFieldFilter(filter, filterableColumns)}>{describeFieldFilter(filter, filterableColumns)}</span>
              <button type="button" className="icon-button" aria-label={`Remove condition ${index + 1}`}
                onClick={() => onFilterRemove?.(index)} disabled={searchDisabled}>
                <X size={13} aria-hidden />
              </button>
            </li>)}
          </ul> : null}
          <div className="filter-fields">
          <label><span>Find field</span><input aria-label="Search filter fields" placeholder="Search a field path"
            value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} /></label>
          <label>
            <span>Field</span>
            <select
              value={filterColumnId}
              disabled={filterableColumns.length === 0}
              onChange={(event) => onFilterColumnChange(event.target.value)}
            >
              {displayedFields.map((column) => <option value={column.id} key={column.id}>{column.label}</option>)}
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
          </div>
          <div className="filter-actions">
            <button type="submit" disabled={searchDisabled || !filterColumnId || filterableColumns.length === 0
              || filters.length >= MAX_FIELD_FILTERS}>Add condition</button>
            <button type="button" onClick={onFilterClear} disabled={searchDisabled || !filterActive}>Clear fields</button>
          </div>
          {filters.length >= MAX_FIELD_FILTERS ? <small>Up to {MAX_FIELD_FILTERS} field conditions. Remove one to add another.</small> : null}
          {matchingFields.length > 50 ? <small>Search a more specific path to find additional fields.</small> : null}
          <small>Scans a bounded source window; limited results are marked.</small>
        </form>
      </details>
    </>
  );
}
