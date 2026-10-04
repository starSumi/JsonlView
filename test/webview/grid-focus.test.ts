import { describe, expect, it } from 'vitest';
import type { RowProjection } from '../../src/shared/types';
import {
  gridCellId, gridCellRowIndex, initialGridCell, moveGridCell, pinActiveGridRow, reconcileGridCell,
  type GridCell, type GridFocusOptions,
} from '../../src/webview/use-grid-focus';

const options: GridFocusOptions = {
  sessionId: 'synthetic-document',
  rows: ['10', '20', '30'].map((ordinal): RowProjection => ({
    ref: { generation: 'g1', ordinal, byteStart: '0', byteEndExclusive: '3', contentByteLength: '2',
      delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: 'Synthetic record',
  })),
  columns: [{ id: '__ordinal', label: '#', source: 'system' }, { id: 'status', label: 'Status', source: 'profile' }],
};

describe('ephemeral grid cell focus', () => {
  it('enters at the selected row first column, or the first data row', () => {
    expect(initialGridCell({ ...options, selectedOrdinal: '20' })).toMatchObject({ ordinal: '20', columnId: '__ordinal' });
    expect(initialGridCell({ ...options, selectedOrdinal: 'missing' })).toMatchObject({ ordinal: '10', columnId: '__ordinal' });
  });

  it.each(['ArrowUp', 'ArrowDown'])('initializes without skipping a row on the first %s', (key) => {
    expect(moveGridCell(undefined, key, false, options)).toMatchObject({ kind: 'data', ordinal: '10' });
    expect(moveGridCell(undefined, key, false, { ...options, selectedOrdinal: '30' })).toMatchObject({ ordinal: '10' });
  });

  it('moves vertically through headers and page rows without changing the column', () => {
    const first: GridCell = { ...initialGridCell(options)!, columnId: 'status' };
    const header = moveGridCell(first, 'ArrowUp', false, options);
    expect(header).toEqual({ kind: 'header', columnId: 'status' });
    expect(moveGridCell(header, 'ArrowUp', false, options)).toEqual(header);
    expect(moveGridCell(header, 'ArrowDown', false, options)).toMatchObject({ ordinal: '10', columnId: 'status' });
    expect(moveGridCell(first, 'ArrowDown', false, options)).toMatchObject({ ordinal: '20', columnId: 'status' });
  });

  it('uses Home and End within the current row and control variants across the page', () => {
    const selected = initialGridCell({ ...options, selectedOrdinal: '20' });
    const end = moveGridCell(selected, 'End', false, options);
    expect(end).toMatchObject({ ordinal: '20', columnId: 'status' });
    expect(moveGridCell(end, 'Home', false, options)).toMatchObject({ ordinal: '20', columnId: '__ordinal' });
    expect(moveGridCell(end, 'Home', true, options)).toEqual({ kind: 'header', columnId: '__ordinal' });
    expect(moveGridCell(end, 'End', true, options)).toMatchObject({ ordinal: '30', columnId: 'status' });
  });

  it('clamps horizontal movement without wrapping rows', () => {
    const first = initialGridCell(options);
    expect(moveGridCell(first, 'ArrowLeft', false, options)).toEqual(first);
    const right = moveGridCell(first, 'ArrowRight', false, options);
    expect(right).toMatchObject({ ordinal: '10', columnId: 'status' });
    expect(moveGridCell(right, 'ArrowRight', false, options)).toEqual(right);
  });

  it('keeps physical identity across row sorting and column reordering', () => {
    const cell = initialGridCell({ ...options, selectedOrdinal: '20' });
    const reordered = { ...options, rows: [...options.rows].reverse(), columns: [...options.columns].reverse() };
    expect(reconcileGridCell(cell, reordered)).toEqual(cell);
    expect(gridCellRowIndex(cell, reordered.rows)).toBe(1);
  });

  it('drops old row, generation and document identities before referencing another page', () => {
    const cell = initialGridCell(options);
    expect(reconcileGridCell(cell, { ...options, rows: options.rows.slice(1) })).toBeUndefined();
    expect(reconcileGridCell(cell, { ...options, rows: options.rows.map((row) => ({ ...row,
      ref: { ...row.ref, generation: 'g2' } })) })).toBeUndefined();
    expect(reconcileGridCell(cell, { ...options, sessionId: 'other-document' })).toBeUndefined();
  });

  it('reconciles a hidden column to the first remaining column without selecting a record', () => {
    const cell: GridCell = { ...initialGridCell(options)!, columnId: 'status' };
    expect(reconcileGridCell(cell, { ...options, columns: options.columns.slice(0, 1) })).toMatchObject({
      ordinal: '10', columnId: '__ordinal',
    });
    expect(reconcileGridCell(cell, { ...options, columns: [] })).toBeUndefined();
  });

  it('does not invent an active data cell for empty pages or columns', () => {
    expect(initialGridCell({ ...options, rows: [] })).toBeUndefined();
    expect(moveGridCell(undefined, 'ArrowDown', false, { ...options, columns: [] })).toBeUndefined();
  });

  it('pins no more than one active data row outside the virtual range', () => {
    const normal = [10, 11, 12];
    expect(pinActiveGridRow(normal, 2, 30)).toEqual([2, 10, 11, 12]);
    expect(pinActiveGridRow(normal, 11, 30)).toEqual(normal);
    expect(pinActiveGridRow(normal, -1, 30)).toEqual(normal);
    expect(pinActiveGridRow(normal, 30, 30)).toEqual(normal);
  });

  it('uses collision-free DOM IDs scoped to document, generation, ordinal and column', () => {
    const ids = [
      gridCellId('a-b', 'c', '10', 'status'), gridCellId('a', 'b-c', '10', 'status'),
      gridCellId('a-b', 'c2', '10', 'status'), gridCellId('a-b', 'c', '11', 'status'),
      gridCellId('a-b', 'c', '10', 'field name'),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => !/\s/.test(id))).toBe(true);
  });
});
