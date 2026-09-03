import type { CellProjection, ColumnSpec, JsonKind, RowProjection } from '../shared/types';

export interface TreePreviewRow {
  path: string;
  depth: number;
  kind: JsonKind;
  preview: string;
}

export const ORDINAL_COLUMN: ColumnSpec = {
  id: '__ordinal',
  label: '#',
  source: 'system',
  width: 88,
};

export const MIN_COLUMN_WIDTH = 96;
export const MAX_COLUMN_WIDTH = 720;

export function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) {
    return value;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatCell(cell: CellProjection | undefined): string {
  if (!cell) {
    return '';
  }
  if (cell.preview !== undefined) {
    return cell.truncated ? `${cell.preview}...` : cell.preview;
  }
  if (cell.value === null) {
    return 'null';
  }
  return cell.value === undefined ? '' : String(cell.value);
}

export function getColumnText(row: RowProjection, columnId: string): string {
  if (columnId === '__ordinal') {
    return row.ref.ordinal;
  }
  return formatCell(row.cells.find((cell) => cell.columnId === columnId));
}

export function visibleColumns(
  columns: ColumnSpec[],
  visibility: Record<string, boolean>,
): ColumnSpec[] {
  const candidates = [ORDINAL_COLUMN, ...columns.filter((column) => column.id !== '$ordinal')];
  const selected = candidates.filter((column) => visibility[column.id] !== false);
  return selected.length > 0 ? selected : [ORDINAL_COLUMN];
}

export function columnGridTemplate(
  columns: ColumnSpec[],
  overrides: Record<string, number> = {},
): string {
  return columns.map((column, index) => {
    if (column.id === '__ordinal') {
      const width = overrides[column.id] ?? column.width ?? 88;
      return `${Math.max(64, Math.min(MAX_COLUMN_WIDTH, width))}px`;
    }
    if (overrides[column.id] !== undefined) {
      return `${Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, overrides[column.id]!))}px`;
    }
    if (column.width) {
      return `minmax(${Math.max(MIN_COLUMN_WIDTH, column.width)}px, ${index === columns.length - 1 ? '2fr' : '1fr'})`;
    }
    return index === columns.length - 1 ? 'minmax(180px, 2fr)' : `minmax(${MIN_COLUMN_WIDTH + 32}px, 1fr)`;
  }).join(' ');
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

function primitivePreview(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  return String(value);
}

export function buildTreePreview(
  value: unknown,
  maxNodes = 500,
  maxDepth = 8,
  maxChildren = 100,
): TreePreviewRow[] {
  const rows: TreePreviewRow[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (rows.length >= maxNodes) return;
    const kind = kindOf(node);
    const composite = kind === 'object' || kind === 'array';
    const size = Array.isArray(node) ? String(node.length) : composite ? boundedObjectSize(node, maxChildren) : '0';
    rows.push({
      path,
      depth,
      kind,
      preview: composite ? `${kind} (${size})` : primitivePreview(node),
    });
    if (!composite || depth >= maxDepth || rows.length >= maxNodes) return;
    if (Array.isArray(node)) {
      const childCount = Math.min(node.length, maxChildren);
      for (let index = 0; index < childCount && rows.length < maxNodes; index += 1) {
        visit(node[index], `${path}[${String(index)}]`, depth + 1);
      }
      if (node.length > maxChildren && rows.length < maxNodes) {
        rows.push({ path: `${path}...`, depth: depth + 1, kind: 'string', preview: `${node.length - maxChildren} more` });
      }
      return;
    }
    let visited = 0;
    let hasMore = false;
    for (const key in node as Record<string, unknown>) {
      if (!Object.hasOwn(node as object, key)) continue;
      if (visited >= maxChildren) {
        hasMore = true;
        break;
      }
      visit((node as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
      visited += 1;
      if (rows.length >= maxNodes) break;
    }
    if (hasMore && rows.length < maxNodes) {
      rows.push({ path: `${path}...`, depth: depth + 1, kind: 'string', preview: 'more fields' });
    }
  };
  visit(value, '$', 0);
  return rows;
}

function boundedObjectSize(value: unknown, limit: number): string {
  if (value === null || typeof value !== 'object') return '0';
  let count = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value as object, key)) continue;
    count += 1;
    if (count > limit) return `${String(limit)}+`;
  }
  return String(count);
}
