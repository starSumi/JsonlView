import type React from 'react';
import { useState } from 'react';
import type { ColumnSpec } from '@shared/types';
import type { FieldTreeNode } from './field-tree';
import { RowTypeFilterFields, type RowTypeChooserProps } from './RowTypeChooser';

export interface FieldTreeProps {
  nodes: readonly FieldTreeNode[];
  expanded: boolean;
  renderColumn: (column: ColumnSpec) => React.ReactNode;
  rowTypes?: RowTypeChooserProps | undefined;
}

export const FIELD_TREE_PAGE_SIZE = 24;

function RowTypeBranch({ node, expanded, rowTypes }: {
  node: FieldTreeNode; expanded: boolean; rowTypes: RowTypeChooserProps;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(expanded);
  const source = node.rowTypes;
  if (source === undefined) return null;
  const selection = rowTypes.selection?.column.id === source.column.id
    && rowTypes.selection.column.source === source.column.source ? rowTypes.selection : undefined;
  return <details className="field-tree-row-types" open={open}
    onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>Match row values{selection ? ` (${selection.values.length})` : ''}</summary>
    {open ? <RowTypeFilterFields sources={[source]} selection={selection}
      disabled={rowTypes.disabled} onChange={rowTypes.onChange} /> : null}
  </details>;
}

function FieldTreeBranch({ node, ...props }: Omit<FieldTreeProps, 'nodes'> & { node: FieldTreeNode }): React.JSX.Element {
  const [open, setOpen] = useState(props.expanded);
  return <details open={open}
    onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary title={node.label}>{node.label}</summary>
    {open ? <>
      {node.column ? props.renderColumn(node.column) : null}
      {node.rowTypes && props.rowTypes ? <RowTypeBranch node={node} expanded={props.expanded} rowTypes={props.rowTypes} /> : null}
      {node.children.length > 0 ? <FieldTree nodes={node.children} {...props} /> : null}
    </> : null}
  </details>;
}

/** Native disclosures keep each branch keyboard reachable without a custom tree protocol. */
export function FieldTree({ nodes, expanded, renderColumn, rowTypes }: FieldTreeProps): React.JSX.Element {
  const [limit, setLimit] = useState(FIELD_TREE_PAGE_SIZE);
  const remaining = Math.max(0, nodes.length - limit);
  return <ul className="field-tree">
    {nodes.slice(0, limit).map((node) => <li key={node.id}>
      {node.children.length > 0 || node.rowTypes !== undefined
        ? <FieldTreeBranch node={node} expanded={expanded} renderColumn={renderColumn} rowTypes={rowTypes} />
        : node.column ? renderColumn(node.column) : null}
    </li>)}
    {remaining > 0 ? <li><button type="button" onClick={() => setLimit((current) => current + FIELD_TREE_PAGE_SIZE)}>
      Show {Math.min(FIELD_TREE_PAGE_SIZE, remaining)} more ({remaining} remaining)
    </button></li> : null}
  </ul>;
}
