import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Braces, GripVertical, LoaderCircle } from 'lucide-react';
import type { ColumnSpec, RecordRef, RowProjection, RowSort } from '../../../shared/types';
import { columnGridTemplate, getColumnText, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '../../format';
import { gridCellId, gridCellRowIndex, pinActiveGridRow, useGridFocus, type GridCell } from '../../use-grid-focus';

interface EmptyStateProps {
  icon?: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  title: string;
}

function EmptyState({ Icon = Braces, title }: EmptyStateProps & {
  Icon?: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}): React.JSX.Element {
  return (
    <div className="empty-state" role="status">
      <Icon size={22} aria-hidden />
      <div className="empty-title">{title}</div>
    </div>
  );
}

export interface RecordTableProps {
  sessionId?: string;
  rows: RowProjection[];
  columns: ColumnSpec[];
  selectedOrdinal?: string | undefined;
  loading: boolean;
  onSelect: (ref: RecordRef) => void;
  columnWidths: Record<string, number>;
  onColumnWidthChange: (columnId: string, width: number | undefined) => void;
  sort?: RowSort | undefined;
  onColumnOrderChange: (order: string[]) => void;
}

const GRID_HEADER_HEIGHT = 30;

export function RecordTable({
  sessionId = 'jsonl-view',
  rows,
  columns,
  selectedOrdinal,
  loading,
  onSelect,
  columnWidths,
  onColumnWidthChange,
  sort,
  onColumnOrderChange,
}: RecordTableProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const resizersRef = useRef(new Map<string, HTMLButtonElement>());
  const pointerFocusRef = useRef(false);
  const [measuredWidths, setMeasuredWidths] = useState<Record<string, number>>({});
  const focus = useGridFocus({ sessionId, rows, columns, selectedOrdinal });
  const activeIndex = gridCellRowIndex(focus.activeCell, rows);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 10,
    scrollMargin: GRID_HEADER_HEIGHT,
    scrollPaddingStart: GRID_HEADER_HEIGHT,
    getItemKey: (index) => rows[index]
      ? gridCellId(sessionId, rows[index]!.ref.generation, rows[index]!.ref.ordinal, '') : index,
    rangeExtractor: (range) => pinActiveGridRow(defaultRangeExtractor(range), activeIndex, rows.length),
  });
  const selectedIndex = rows.findIndex((row) => row.ref.ordinal === selectedOrdinal);
  const selectedGeneration = rows[selectedIndex]?.ref.generation;
  const template = useMemo(() => columnGridTemplate(columns, columnWidths), [columnWidths, columns]);
  const resizeRef = useRef<{ columnId: string; startX: number; startWidth: number } | undefined>(undefined);
  const dragColumnRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = (): void => {
      const widths: Record<string, number> = {};
      for (const heading of header.querySelectorAll<HTMLElement>('[data-column-id]')) {
        const id = heading.dataset.columnId;
        if (id) widths[id] = Math.round(heading.getBoundingClientRect().width);
      }
      setMeasuredWidths((previous) => Object.keys(widths).every((id) => widths[id] === previous[id])
        && Object.keys(widths).length === Object.keys(previous).length ? previous : widths);
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(header);
    for (const heading of header.children) observer?.observe(heading);
    measure();
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const active = resizeRef.current;
      if (!active) return;
      const width = Math.max(
        active.columnId === '__ordinal' ? 64 : MIN_COLUMN_WIDTH,
        Math.min(MAX_COLUMN_WIDTH, active.startWidth + event.clientX - active.startX),
      );
      onColumnWidthChange(active.columnId, width);
    };
    const stopResize = (): void => {
      resizeRef.current = undefined;
      pointerFocusRef.current = false;
      document.body.classList.remove('is-resizing-column');
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResize, { passive: true });
    window.addEventListener('pointercancel', stopResize, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      stopResize();
    };
  }, [onColumnWidthChange]);

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex, virtualizer]);

  const revealCell = (cell: GridCell | undefined): void => {
    const index = gridCellRowIndex(cell, rows);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
    else if (cell?.kind === 'header') scrollRef.current?.scrollTo({ top: 0 });
  };
  const clearPointerFocus = (): void => { pointerFocusRef.current = false; };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (loading || event.target !== event.currentTarget || event.altKey || event.metaKey) return;
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      revealCell(focus.move(event.key, event.ctrlKey));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const cell = focus.activeCell ?? focus.enter();
      if (cell?.kind === 'header') resizersRef.current.get(cell.columnId)?.focus();
      else {
        const index = gridCellRowIndex(cell, rows);
        const row = rows[index];
        if (row) { revealCell(cell); onSelect(row.ref); }
      }
    }
  };

  const virtualItems = virtualizer.getVirtualItems();
  const activeCell = focus.activeCell;
  const headerGeneration = rows[0]?.ref.generation ?? 'empty';
  const activeDescendant = activeCell?.kind === 'header'
    ? gridCellId(sessionId, headerGeneration, 'header', activeCell.columnId)
    : activeCell && virtualItems.some((item) => item.index === activeIndex)
      ? gridCellId(sessionId, activeCell.generation, activeCell.ordinal, activeCell.columnId) : undefined;

  useLayoutEffect(() => {
    const grid = scrollRef.current;
    const cell = activeDescendant ? document.getElementById(activeDescendant) : null;
    if (!grid || !cell || !grid.contains(cell)) return;
    const viewport = grid.getBoundingClientRect();
    const bounds = cell.getBoundingClientRect();
    if (bounds.left < viewport.left || bounds.width > viewport.width) grid.scrollLeft += bounds.left - viewport.left;
    else if (bounds.right > viewport.right) grid.scrollLeft += bounds.right - viewport.right;
  }, [activeDescendant]);

  if (rows.length === 0) {
    return loading
      ? <EmptyState Icon={LoaderCircle} title="Loading records" />
      : <EmptyState title="No records match the current query" />;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualized absolute-positioned CSS grid requires ARIA grid semantics
    <div
      className={`data-grid-scroll${loading ? ' is-refreshing' : ''}`}
      ref={scrollRef}
      role={/* biome-ignore lint/a11y/useSemanticElements: virtualized absolute-positioned CSS grid requires ARIA grid semantics */ 'grid'}
      aria-label="JSONL records"
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      aria-busy={loading}
      aria-activedescendant={activeDescendant}
      aria-description="Arrow keys move cell focus. Enter or Space opens a record. Enter on a header enables column resizing; Escape returns to grid navigation."
      tabIndex={0}
      onPointerDownCapture={() => { pointerFocusRef.current = true; }}
      onPointerUpCapture={clearPointerFocus}
      onPointerCancelCapture={clearPointerFocus}
      onPointerLeave={clearPointerFocus}
      onFocus={(event) => {
        // Pointer focus on the gutter or virtual space must not reveal a default row.
        const pointerEntry = pointerFocusRef.current;
        clearPointerFocus();
        if (!loading && !pointerEntry && event.target === event.currentTarget
          && !event.currentTarget.contains(event.relatedTarget as Node | null)) revealCell(focus.enter());
      }}
      onKeyDown={handleKeyDown}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: virtualized CSS grid header cannot be a native table row */}
      <div ref={headerRef} className="data-grid-header" role="row" aria-rowindex={1} tabIndex={-1} style={{ gridTemplateColumns: template, height: GRID_HEADER_HEIGHT }}>
        {columns.map((column, columnIndex) => {
          const minimum = column.id === '__ordinal' ? 64 : MIN_COLUMN_WIDTH;
          const width = measuredWidths[column.id] ?? columnWidths[column.id] ?? column.width ?? 160;
          const currentWidth = Math.max(minimum, width);
          return (
          // biome-ignore lint/a11y/useSemanticElements: virtualized CSS grid heading cannot be a native table cell
          <div
            className={`data-grid-heading${activeCell?.kind === 'header' && activeCell.columnId === column.id ? ' is-active-cell' : ''}`}
            role="columnheader"
            id={gridCellId(sessionId, headerGeneration, 'header', column.id)}
            aria-colindex={columnIndex + 1}
            tabIndex={-1}
            data-column-id={column.id}
            key={column.id}
            title={column.label}
            aria-sort={sort?.columnId === column.id ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
            draggable={column.id !== '__ordinal'}
            onDragStart={(event) => {
              if (column.id === '__ordinal') {
                event.preventDefault();
                return;
              }
              dragColumnRef.current = column.id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', column.id);
            }}
            onDragOver={(event) => {
              if (column.id !== '__ordinal' && dragColumnRef.current !== undefined) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = dragColumnRef.current ?? event.dataTransfer.getData('text/plain');
              dragColumnRef.current = undefined;
              if (!source || source === column.id || column.id === '__ordinal') return;
              const order = columns.filter((candidate) => candidate.id !== '__ordinal').map((candidate) => candidate.id);
              const from = order.indexOf(source);
              const to = order.indexOf(column.id);
              if (from < 0 || to < 0) return;
              order.splice(from, 1);
              order.splice(to, 0, source);
              onColumnOrderChange(order);
            }}
            onDragEnd={() => { dragColumnRef.current = undefined; }}
          >
            {column.id !== '__ordinal' ? <GripVertical size={11} className="column-drag-handle" aria-hidden /> : null}
            <span className="data-grid-heading-label">{column.label}</span>
            {/* biome-ignore lint/a11y/useSemanticElements: the column resizer is an interactive separator button */}
            <button
              type="button"
              className="column-resizer"
              ref={(element) => {
                if (element) resizersRef.current.set(column.id, element);
                else resizersRef.current.delete(column.id);
              }}
              role="separator"
              tabIndex={-1}
              aria-orientation="vertical"
              aria-controls={gridCellId(sessionId, headerGeneration, 'header', column.id)}
              aria-label={`Resize ${column.label} column`}
              aria-valuemin={minimum}
              aria-valuemax={Math.max(MAX_COLUMN_WIDTH, currentWidth)}
              aria-valuenow={currentWidth}
              aria-valuetext={`${currentWidth} pixels wide`}
              title="Drag or use Left and Right to resize; Escape returns to the header; double-click to reset"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const width = event.currentTarget.parentElement?.getBoundingClientRect().width
                  ?? columnWidths[column.id]
                  ?? column.width
                  ?? 160;
                resizeRef.current = { columnId: column.id, startX: event.clientX, startWidth: width };
                document.body.classList.add('is-resizing-column');
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onColumnWidthChange(column.id, undefined);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  onColumnWidthChange(column.id, Math.max(minimum,
                    Math.min(MAX_COLUMN_WIDTH, currentWidth + (event.key === 'ArrowLeft' ? -16 : 16))));
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  focus.setActiveCell({ kind: 'header', columnId: column.id });
                  scrollRef.current?.focus();
                }
              }}
            />
          </div>
        ); })}
      </div>
      <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const selected = row.ref.ordinal === selectedOrdinal;
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: grid focus is owned by the aria-activedescendant container
            // biome-ignore lint/a11y/useSemanticElements: virtualized absolute-positioned CSS grid row cannot be a native table row
            <div
              className={`data-grid-row${selected ? ' is-selected' : ''}${row.problems?.length ? ' has-problem' : ''}`}
              role="row"
              aria-rowindex={item.index + 2}
              aria-selected={selected}
              tabIndex={-1}
              key={gridCellId(sessionId, row.ref.generation, row.ref.ordinal, '')}
              style={{ gridTemplateColumns: template, height: item.size, transform: `translateY(${item.start - GRID_HEADER_HEIGHT}px)` }}
            >
              {columns.map((column, columnIndex) => {
                const text = getColumnText(row, column.id);
                const active = activeCell?.kind === 'data' && activeCell.generation === row.ref.generation
                  && activeCell.ordinal === row.ref.ordinal && activeCell.columnId === column.id;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: virtualized CSS grid cell cannot be a native table cell
                  // biome-ignore lint/a11y/useFocusableInteractive: grid focus is owned by the aria-activedescendant container
                  <div
                    className={`data-grid-cell${active ? ' is-active-cell' : ''}`}
                    role="gridcell"
                    id={gridCellId(sessionId, row.ref.generation, row.ref.ordinal, column.id)}
                    aria-colindex={columnIndex + 1}
                    tabIndex={-1}
                    key={column.id}
                    title={text}
                    onClick={() => {
                      if (loading) return;
                      focus.setActiveCell({ kind: 'data', sessionId, generation: row.ref.generation,
                        ordinal: row.ref.ordinal, columnId: column.id });
                      scrollRef.current?.focus({ preventScroll: true });
                      onSelect(row.ref);
                    }}
                    onKeyDown={(event) => {
                      if (loading || (event.key !== 'Enter' && event.key !== ' ')) return;
                      event.preventDefault();
                      focus.setActiveCell({ kind: 'data', sessionId, generation: row.ref.generation,
                        ordinal: row.ref.ordinal, columnId: column.id });
                      scrollRef.current?.focus({ preventScroll: true });
                      onSelect(row.ref);
                    }}
                  >
                    {column.id === '__ordinal' && row.ref.parseState !== 'valid'
                      ? <span className="parse-dot" data-state={row.ref.parseState} role="img" aria-label={row.ref.parseState} />
                      : null}
                    <span className="cell-text">{text || (column.id === '__ordinal' ? row.ref.ordinal : '')}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
