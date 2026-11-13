import type React from 'react';
import { useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Filter, Search, X } from 'lucide-react';
import type { ColumnSpec, RowFilter, RowFilterOperator, SortDirection } from '@shared/types';
import { useLightDismiss } from '@webview/shared/hooks/use-light-dismiss';
import { useViewportPopover } from '@webview/use-viewport-popover';
import { describeFieldFilter, MAX_FIELD_FILTERS } from './query-selection';
import { RowTypeFilterFields, type RowTypeChooserProps } from './RowTypeChooser';

export interface FilterOperatorOption {
  value: RowFilterOperator;
  label: string;
  needsValue: boolean;
}

export interface RecordQueryControlsProps {
  controlNamePrefix?: string;
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
  rowTypes?: RowTypeChooserProps | undefined;
}

export function RecordQueryControls({
  controlNamePrefix = 'record',
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
  rowTypes,
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
  const nextSortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  const sortUnavailable = searchDisabled || (nextSortDirection === 'desc' && descendingDisabled);
  const sortAction = nextSortDirection === 'desc'
    ? 'Sort rows descending; last line first'
    : 'Sort rows ascending; first line first';
  const sortUnavailableReason = nextSortDirection === 'desc' && descendingDisabled ? descendingDisabledReason : undefined;
  const selectedRowTypes = rowTypes?.selection?.values.length ?? 0;
  const filterCount = filters.length + selectedRowTypes;
  const searchFormId = `${controlNamePrefix}-search-form`;

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: This form both submits the table query and provides its search landmark. */}
      <form
        id={searchFormId}
        className="search-box"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (!searchDisabled) onSearchSubmit();
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
      <button
        type="button"
        className="row-order-control"
        data-direction={sortDirection}
        aria-label="Descending row order; last line first"
        aria-pressed={sortDirection === 'desc'}
        aria-description={sortUnavailableReason}
        title={sortUnavailableReason ?? sortAction}
        disabled={sortUnavailable}
        onClick={() => onSortDirectionChange(nextSortDirection)}
      >
        {sortDirection === 'asc' ? <ArrowUpNarrowWide size={15} aria-hidden /> : <ArrowDownWideNarrow size={15} aria-hidden />}
        <span className="query-tool-label" aria-hidden="true">{sortDirection === 'asc' ? 'Asc' : 'Desc'}</span>
      </button>
      <details className="filter-menu" ref={filterMenuRef}>
        <summary className={`query-tool-button${filterActive || selectedRowTypes > 0 ? ' is-active' : ''}`}
          title={rowTypes ? 'Filters: field conditions and row types' : 'Field filters: match all conditions'}
          aria-label={rowTypes ? 'Filters' : 'Field filters'}
          aria-description={rowTypes
            ? `${filters.length} field conditions applied; ${selectedRowTypes} row types selected`
            : filters.length ? `${filters.length} field conditions applied` : undefined}>
          <Filter size={15} aria-hidden /><span className="query-tool-label">{rowTypes ? 'Filters' : 'Field filters'}</span>
          {filterCount ? <span className="query-tool-count" aria-hidden="true">({filterCount})</span> : null}
        </summary>
        <div className="filter-popover query-filters-popover" data-popover-width="340" data-popover-height="560">
        <form
          className="field-filter-form"
          aria-labelledby={`${controlNamePrefix}-field-filters`}
          onSubmit={(event) => {
            event.preventDefault();
            onFilterSubmit();
          }}
        >
          <strong id={`${controlNamePrefix}-field-filters`}>Field filters</strong>
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
        {rowTypes ? <RowTypeFilterFields {...rowTypes} /> : null}
        </div>
      </details>
    </>
  );
}
