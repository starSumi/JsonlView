import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { JsonKind } from '../shared/types';

export const JSON_TREE_ROOT_ID = '$';

export interface JsonTreeRow {
  id: string;
  label: string;
  depth: number;
  kind: JsonKind;
  preview: string;
  expandable: boolean;
  expanded: boolean;
  limited: boolean;
}

export interface JsonTreeResult {
  rows: JsonTreeRow[];
  limited: boolean;
}

export interface JsonTreeOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxChildren?: number;
  maxPreviewChars?: number;
}

function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return 'string';
}

function primitivePreview(value: unknown, maxChars: number): string {
  if (typeof value === 'string') {
    const visible = value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
    return JSON.stringify(visible);
  }
  if (value === null) return 'null';
  return String(value);
}

function previewClass(kind: JsonKind): string {
  if (kind === 'string') return 'json-token-string';
  if (kind === 'integer' || kind === 'number') return 'json-token-number';
  if (kind === 'boolean') return 'json-token-boolean';
  if (kind === 'null') return 'json-token-null';
  return 'json-token-punctuation';
}

function objectSize(value: Record<string, unknown>, limit: number): string {
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    if (count > limit) return `${String(limit)}+`;
  }
  return String(count);
}

function childId(parentId: string, kind: 'key' | 'index', value: string | number): string {
  return `${parentId}/${kind}:${encodeURIComponent(String(value))}`;
}

function safeProperty(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return '[Unreadable property]';
  }
}

export function buildVisibleJsonTree(
  value: unknown,
  expandedIds: ReadonlySet<string>,
  options: JsonTreeOptions = {},
): JsonTreeResult {
  const maxNodes = Math.max(1, options.maxNodes ?? 500);
  const maxDepth = Math.max(0, options.maxDepth ?? 12);
  const maxChildren = Math.max(1, options.maxChildren ?? 100);
  const maxPreviewChars = Math.max(8, options.maxPreviewChars ?? 256);
  const rows: JsonTreeRow[] = [];
  const ancestors = new WeakSet<object>();
  let limited = false;

  const visit = (node: unknown, id: string, label: string, depth: number): void => {
    if (rows.length >= maxNodes) {
      limited = true;
      return;
    }
    const kind = kindOf(node);
    const composite = (kind === 'object' || kind === 'array') && node !== null;
    const circular = composite && ancestors.has(node as object);
    const depthLimited = composite && depth >= maxDepth;
    if (depthLimited) limited = true;
    const expanded = composite && !circular && !depthLimited && expandedIds.has(id);
    const size = Array.isArray(node)
      ? String(node.length)
      : composite
        ? objectSize(node as Record<string, unknown>, maxChildren)
        : '0';
    rows.push({
      id,
      label,
      depth,
      kind,
      preview: circular
        ? '[Circular]'
        : composite
          ? `${kind} (${size})${depthLimited ? ' - depth limit' : ''}`
          : primitivePreview(node, maxPreviewChars),
      expandable: composite && !circular && !depthLimited,
      expanded,
      limited: circular || depthLimited,
    });

    if (!expanded || !composite || rows.length >= maxNodes) return;
    ancestors.add(node as object);
    if (Array.isArray(node)) {
      const count = Math.min(node.length, maxChildren);
      let visited = 0;
      for (let index = 0; index < count; index += 1) {
        visit(node[index], childId(id, 'index', index), `[${String(index)}]`, depth + 1);
        visited += 1;
        if (rows.length >= maxNodes) {
          if (visited < count) limited = true;
          break;
        }
      }
      if (node.length > count) limited = true;
    } else {
      let count = 0;
      for (const key in node as Record<string, unknown>) {
        if (!Object.hasOwn(node as object, key)) continue;
        if (count >= maxChildren) {
          limited = true;
          break;
        }
        visit(
          safeProperty(node as Record<string, unknown>, key),
          childId(id, 'key', key),
          key,
          depth + 1,
        );
        count += 1;
        if (rows.length >= maxNodes) {
          limited = true;
          break;
        }
      }
    }
    ancestors.delete(node as object);
  };

  visit(value, JSON_TREE_ROOT_ID, '$', 0);
  return { rows, limited };
}

interface JsonTreeProps {
  value: unknown;
}

export function JsonTree({ value }: JsonTreeProps): React.JSX.Element {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set([JSON_TREE_ROOT_ID]));
  const tree = useMemo(() => buildVisibleJsonTree(value, expandedIds), [expandedIds, value]);

  const toggle = (id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="tree-preview" role="tree" aria-label="Bounded JSON tree">
      {tree.rows.map((row) => (
        <div
          className={`tree-row${row.limited ? ' is-limited' : ''}`}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.expandable ? row.expanded : undefined}
          key={row.id}
        >
          <div className="tree-path" style={{ paddingLeft: row.depth * 14 }} title={row.label}>
            {row.expandable ? (
              <button
                type="button"
                className="tree-toggle"
                onClick={() => toggle(row.id)}
                aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.label}`}
              >
                {row.expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              </button>
            ) : <span className="tree-toggle-spacer" aria-hidden />}
            <span className={`tree-label ${row.depth === 0 ? '' : 'json-token-key'}`}>{row.label}</span>
          </div>
          <span className={`tree-kind kind-${row.kind}`}>{row.kind}</span>
          <span className={`tree-value ${previewClass(row.kind)}`} title={row.preview}>{row.preview}</span>
        </div>
      ))}
      {tree.limited ? <div className="tree-budget-notice" role="note">Tree preview reached its depth, child, or node budget.</div> : null}
    </div>
  );
}
