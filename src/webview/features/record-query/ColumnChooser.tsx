import type React from 'react';
import { useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';
import type { ColumnSpec, FieldStats } from '../../../shared/types';
import { useLightDismiss } from '../../shared/hooks/use-light-dismiss';
import { useViewportPopover } from '../../use-viewport-popover';
import { buildColumnCatalog, fieldColumnReason } from './column-catalog';

export interface ColumnChooserProps {
  columns: readonly ColumnSpec[];
  schema: readonly FieldStats[];
  selectedRecordIds: ReadonlySet<string>;
  visibility: Readonly<Record<string, boolean>>;
  recordColumnLimit: number;
  schemaComplete: boolean;
  schemaLoadFailed: boolean;
  onRetrySchema: () => void;
  onVisibilityChange: (column: ColumnSpec, visible: boolean) => void;
}

export function ColumnChooser(props: ColumnChooserProps): React.JSX.Element {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useLightDismiss(menuRef);
  useViewportPopover(menuRef);
  const [search, setSearch] = useState('');
  const catalog = buildColumnCatalog(props.columns, props.schema, props.selectedRecordIds);
  const term = search.trim().toLocaleLowerCase();
  const matches = (column: ColumnSpec): boolean => column.label.toLocaleLowerCase().includes(term);
  const renderColumn = (column: ColumnSpec): React.JSX.Element => {
    const record = column.source === 'record';
    const checked = column.id === '__ordinal' || (record ? props.selectedRecordIds.has(column.id)
      : props.visibility[column.id] !== false);
    const limitReached = record && !checked && props.selectedRecordIds.size >= props.recordColumnLimit;
    const reason = fieldColumnReason(column, props.schema);
    return <label key={column.id} title={limitReached ? `Up to ${props.recordColumnLimit} record fields can be shown at once` : reason}>
      <input type="checkbox" checked={checked} disabled={column.id === '__ordinal' || limitReached}
        onChange={(event) => props.onVisibilityChange(column, event.target.checked)} />
      <span title={column.label}>{column.label}</span>
    </label>;
  };
  const fields = catalog.fields.filter(matches);
  const advanced = catalog.advanced.filter(matches);
  return <details ref={menuRef} className="columns-menu">
    <summary className="query-tool-button" title="Columns: choose what the table displays" aria-label="Columns">
      <Columns3 size={15} aria-hidden /><span className="query-tool-label">Columns</span>
    </summary>
    <div className="columns-popover column-chooser" data-popover-width="320" data-popover-height="480">
      <strong>Columns</strong>
      <small>Controls this table’s display. Rows and filters stay the same.</small>
      <fieldset><legend>Common columns</legend>{catalog.common.map(renderColumn)}</fieldset>
      {catalog.configured.length > 0 ? <fieldset><legend>Selected record fields</legend>
        {catalog.configured.map(renderColumn)}</fieldset> : null}
      <div className="field-column-search">
        <strong>Add field column</strong>
        <input value={search} aria-label="Search field columns" placeholder="Search a field path"
          onChange={(event) => setSearch(event.target.value)} />
      </div>
      <fieldset><legend>Short scalar fields</legend>
        {fields.slice(0, term ? 250 : 12).map(renderColumn)}
        {!term && fields.length > 12 ? <small>Search to find {fields.length - 12} more fields.</small> : null}
        {fields.length === 0 ? <small>No matching short scalar fields in the loaded schema.</small> : null}
      </fieldset>
      {advanced.length > 0 ? <details className="advanced-columns">
        <summary>Advanced fields ({advanced.length})</summary>
        <small>Objects, arrays, long content and sparse fields are usually easier to read in record details.
          Search a path to explicitly add a column.</small>
        {term ? advanced.map(renderColumn) : <small>Enter a field path above to show matching advanced fields.</small>}
      </details> : null}
      <small>Field shapes and lengths use observed schema samples.{props.schemaComplete ? '' : ' More fields may appear while schema loads.'}</small>
      {props.schemaLoadFailed ? <button type="button" onClick={props.onRetrySchema}>Retry fields</button> : null}
    </div>
  </details>;
}
