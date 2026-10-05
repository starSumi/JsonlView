import { useEffect, useRef, useState } from 'react';
import type { ColumnSpec, RowProjection } from '../shared/types';

export type GridCell =
  | { kind: 'header'; columnId: string }
  | { kind: 'data'; sessionId: string; generation: string; ordinal: string; columnId: string };

export interface GridFocusOptions {
  sessionId: string;
  rows: readonly RowProjection[];
  columns: readonly ColumnSpec[];
  selectedOrdinal?: string | undefined;
}

export function gridCellId(sessionId: string, generation: string, ordinal: string, columnId: string): string {
  return `jsonl-cell-${encodeURIComponent(JSON.stringify([sessionId, generation, ordinal, columnId]))}`;
}

export function initialGridCell({ sessionId, rows, columns, selectedOrdinal }: GridFocusOptions): GridCell | undefined {
  const column = columns[0];
  const row = rows.find((candidate) => candidate.ref.ordinal === selectedOrdinal) ?? rows[0];
  return column && row
    ? { kind: 'data', sessionId, generation: row.ref.generation, ordinal: row.ref.ordinal, columnId: column.id }
    : undefined;
}

export function reconcileGridCell(cell: GridCell | undefined, options: GridFocusOptions): GridCell | undefined {
  if (!cell || options.columns.length === 0) return undefined;
  const columnId = options.columns.some((column) => column.id === cell.columnId)
    ? cell.columnId : options.columns[0]!.id;
  if (cell.kind === 'header') return columnId === cell.columnId ? cell : { ...cell, columnId };
  if (cell.sessionId !== options.sessionId || !options.rows.some((row) =>
    row.ref.generation === cell.generation && row.ref.ordinal === cell.ordinal)) return undefined;
  return columnId === cell.columnId ? cell : { ...cell, columnId };
}

export function gridCellRowIndex(cell: GridCell | undefined, rows: readonly RowProjection[]): number {
  return cell?.kind === 'data'
    ? rows.findIndex((row) => row.ref.generation === cell.generation && row.ref.ordinal === cell.ordinal)
    : -1;
}

export function moveGridCell(
  cell: GridCell | undefined,
  key: string,
  control: boolean,
  options: GridFocusOptions,
): GridCell | undefined {
  const current = reconcileGridCell(cell, options);
  if (!current && (key === 'ArrowUp' || key === 'ArrowDown')) {
    return initialGridCell({ ...options, selectedOrdinal: undefined });
  }
  const initial = current ?? initialGridCell(options);
  if (!initial) return undefined;
  const lastColumn = options.columns.length - 1;
  let columnIndex = options.columns.findIndex((column) => column.id === initial.columnId);
  let rowIndex = initial.kind === 'header' ? -1 : gridCellRowIndex(initial, options.rows);
  if (key === 'Home' && control) { rowIndex = -1; columnIndex = 0; }
  else if (key === 'End' && control) { rowIndex = options.rows.length - 1; columnIndex = lastColumn; }
  else if (key === 'ArrowLeft') columnIndex = Math.max(0, columnIndex - 1);
  else if (key === 'ArrowRight') columnIndex = Math.min(lastColumn, columnIndex + 1);
  else if (key === 'ArrowUp') rowIndex = Math.max(-1, rowIndex - 1);
  else if (key === 'ArrowDown') rowIndex = Math.min(options.rows.length - 1, rowIndex + 1);
  else if (key === 'Home') columnIndex = 0;
  else if (key === 'End') columnIndex = lastColumn;
  else return current;
  const columnId = options.columns[columnIndex]!.id;
  const row = options.rows[rowIndex];
  return rowIndex < 0 ? { kind: 'header', columnId } : row
    ? { kind: 'data', sessionId: options.sessionId, generation: row.ref.generation, ordinal: row.ref.ordinal, columnId }
    : undefined;
}

// Adds only the active data row to the virtualizer's normal bounded range.
export function pinActiveGridRow(indexes: readonly number[], activeIndex: number, count: number): number[] {
  if (activeIndex < 0 || activeIndex >= count || !Number.isInteger(activeIndex) || indexes.includes(activeIndex)) {
    return [...indexes];
  }
  return [...indexes, activeIndex].sort((left, right) => left - right);
}

export function useGridFocus(options: GridFocusOptions): {
  activeCell: GridCell | undefined;
  enter: () => GridCell | undefined;
  move: (key: string, control: boolean) => GridCell | undefined;
  setActiveCell: (cell: GridCell) => void;
} {
  const [storedCell, setStoredCell] = useState<GridCell>();
  const activeCell = reconcileGridCell(storedCell, options);
  const activeRef = useRef(activeCell);
  activeRef.current = activeCell;
  useEffect(() => {
    if (storedCell !== activeCell) setStoredCell((candidate) => candidate === storedCell ? activeCell : candidate);
  }, [storedCell, activeCell]);
  const set = (cell: GridCell | undefined): GridCell | undefined => {
    activeRef.current = cell;
    setStoredCell(cell);
    return cell;
  };
  return {
    activeCell,
    enter: () => set(initialGridCell(options)),
    move: (key, control) => set(moveGridCell(activeRef.current, key, control, options)),
    setActiveCell: (cell) => { set(reconcileGridCell(cell, options)); },
  };
}
