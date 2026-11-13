import { displayFieldPath, type ColumnSpec, type PathToken } from '@shared/types';
import type { RowTypeSource } from './query-selection';

export interface FieldTreeNode {
  id: string;
  label: string;
  column?: ColumnSpec;
  rowTypes?: RowTypeSource;
  children: FieldTreeNode[];
}

/** Array groups are presentation only. Every selectable leaf retains its exact path. */
export function buildFieldTree(columns: readonly ColumnSpec[], rowTypes: readonly RowTypeSource[] = []): FieldTreeNode[] {
  const roots: FieldTreeNode[] = [];
  const nodes = new Map<string, FieldTreeNode>();
  const add = (column: ColumnSpec): FieldTreeNode => {
    if (column.path === undefined || column.path.tokens.length === 0) {
      const id = `${column.source}:${column.id}`;
      let node = nodes.get(id);
      if (node === undefined) {
        node = { id, label: column.label, children: [] };
        nodes.set(id, node); roots.push(node);
      }
      return node;
    }
    const prefix: PathToken[] = [];
    let children = roots;
    let node: FieldTreeNode | undefined;
    for (const token of column.path.tokens) {
      if (token.kind === 'index') {
        const id = `${JSON.stringify(prefix)}:array`;
        let group = nodes.get(id);
        if (group === undefined) {
          group = { id, label: `${displayFieldPath({ tokens: prefix })}[]`, children: [] };
          nodes.set(id, group); children.push(group);
        }
        children = group.children;
      }
      prefix.push(token);
      const id = JSON.stringify(prefix);
      node = nodes.get(id);
      if (node === undefined) {
        node = { id, label: displayFieldPath({ tokens: prefix }), children: [] };
        nodes.set(id, node); children.push(node);
      }
      children = node.children;
    }
    // The empty path case is handled above.
    return node as FieldTreeNode;
  };
  for (const column of columns) add(column).column = column;
  for (const source of rowTypes) add(source.column).rowTypes = source;
  return roots;
}

export function matchingFieldTree(nodes: readonly FieldTreeNode[], search: string): FieldTreeNode[] {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return [...nodes];
  // Use an explicit stack even though product record paths are bounded. Searching
  // a branch must not recursively mount it or consume the JavaScript call stack.
  const matches: FieldTreeNode[] = [];
  type Visit = { node: FieldTreeNode; output: FieldTreeNode[]; children?: FieldTreeNode[] };
  const pending: Visit[] = [...nodes].reverse().map((node) => ({ node, output: matches }));
  while (pending.length > 0) {
    const { node, output, children } = pending.pop()!;
    if (children !== undefined) {
      if (children.length > 0) output.push({ ...node, children });
    } else if (node.label.toLocaleLowerCase().includes(term)
      || node.column?.label.toLocaleLowerCase().includes(term)
      || node.rowTypes?.values.some((value) => value.toLocaleLowerCase().includes(term))) output.push(node);
    else {
      const matchingChildren: FieldTreeNode[] = [];
      pending.push({ node, output, children: matchingChildren });
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.children[index]!, output: matchingChildren });
      }
    }
  }
  return matches;
}
