import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';
import type { ColumnSpec, FieldStats } from '@shared/types';
import { useLightDismiss } from '@webview/shared/hooks/use-light-dismiss';
import { useViewportPopover } from '@webview/use-viewport-popover';
import { buildColumnCatalog, fieldColumnReason } from './column-catalog';
import { buildFieldTree, matchingFieldTree } from './field-tree';
import { FieldTree } from './FieldTree';
import type { RowTypeChooserProps } from './RowTypeChooser';

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
  rowTypes?: RowTypeChooserProps | undefined;
}

export function ColumnChooser(props: ColumnChooserProps): React.JSX.Element {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useLightDismiss(menuRef);
  useViewportPopover(menuRef);
  const [search, setSearch] = useState('');
  const catalog = useMemo(() => buildColumnCatalog(props.columns, props.schema, props.selectedRecordIds),
    [props.columns, props.schema, props.selectedRecordIds]);
  const term = search.trim().toLocaleLowerCase();
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
  const trees = useMemo(() => ({
    common: buildFieldTree(catalog.common, props.rowTypes?.sources.filter((source) => source.column.source !== 'record')),
    fields: buildFieldTree([...catalog.configured, ...catalog.fields, ...catalog.advanced],
      props.rowTypes?.sources.filter((source) => source.column.source === 'record')),
  }), [catalog, props.rowTypes?.sources]);
  const commonTree = useMemo(() => matchingFieldTree(trees.common, term), [trees.common, term]);
  const fieldTree = useMemo(() => matchingFieldTree(trees.fields, term), [trees.fields, term]);
  const selectedTypes = props.rowTypes?.selection?.values.length ?? 0;
  return <details ref={menuRef} className="columns-menu">
    <summary className={`query-tool-button${selectedTypes ? ' is-active' : ''}`}
      title="Columns and row types: browse fields and choose matching rows" aria-label="Columns"
      aria-description={props.rowTypes ? `${selectedTypes} row types selected` : undefined}>
      <Columns3 size={15} aria-hidden /><span className="query-tool-label">Columns</span>
      {selectedTypes ? <span className="query-tool-count" aria-hidden="true">({selectedTypes})</span> : null}
    </summary>
    <div className="columns-popover column-chooser" data-popover-width="320" data-popover-height="480">
      <strong>Columns and row types</strong>
      <small>Column checkboxes change the display. Match row values filters records independently.</small>
      {props.rowTypes ? <small>Choose row values from one field at a time. Values within that field match any selected value.</small> : null}
      <div className="field-column-search">
        <input value={search} aria-label="Search field columns" placeholder="Search fields or row values"
          onChange={(event) => setSearch(event.target.value)} />
      </div>
      <details className="field-tree-section" open><summary>Default fields</summary>
        <FieldTree key={term} nodes={commonTree} expanded={false} renderColumn={renderColumn} rowTypes={props.rowTypes} />
      </details>
      <details className="field-tree-section" open><summary>Dynamic fields</summary>
        <FieldTree key={term} nodes={fieldTree} expanded={false} renderColumn={renderColumn} rowTypes={props.rowTypes} />
        {fieldTree.length === 0 ? <small>No matching dynamic fields in the loaded schema.</small> : null}
      </details>
      <small>Expand matching branches to reach fields. Each level loads more on request. Expand [] groups to choose an exact array item.</small>
      <small>Field shapes and lengths use observed schema samples.{props.schemaComplete ? '' : ' More fields may appear while schema loads.'}</small>
      {props.schemaLoadFailed ? <button type="button" onClick={props.onRetrySchema}>Retry fields</button> : null}
    </div>
  </details>;
}
