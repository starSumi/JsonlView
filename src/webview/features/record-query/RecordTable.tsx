import React, { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Braces, GripVertical, LoaderCircle } from 'lucide-react';
import type { ColumnSpec, RecordRef, RowProjection, RowSort } from '../../../shared/types';
import { columnGridTemplate, getColumnText, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '../../format';

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
  rows: RowProjection[];
  columns: ColumnSpec[];
  selectedOrdinal?: string | undefined;
  loading: boolean;
  onSelect: (ref: RecordRef) => void;
  columnWidths: Record<string, number>;
  onColumnWidthChange: (columnId: string, width: number | undefined) => void;
  sort?: RowSort | undefined;
  onSortChange: (sort: RowSort | undefined) => void;
  onColumnOrderChange: (order: string[]) => void;
}

export function RecordTable({
  rows,
  columns,
  selectedOrdinal,
  loading,
  onSelect,
  columnWidths,
  onColumnWidthChange,
  sort,
  onSortChange,
  onColumnOrderChange,
}: RecordTableProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 10,
    getItemKey: (index) => rows[index]?.ref.ordinal ?? index,
  });
  const selectedIndex = rows.findIndex((row) => row.ref.ordinal === selectedOrdinal);
  const template = useMemo(() => columnGridTemplate(columns, columnWidths), [columnWidths, columns]);
  const resizeRef = useRef<{ columnId: string; startX: number; startWidth: number } | undefined>(undefined);
  const dragColumnRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const active = resizeRef.current;
      if (!active) return;
      const width = Math.max(
        MIN_COLUMN_WIDTH,
        Math.min(MAX_COLUMN_WIDTH, active.startWidth + event.clientX - active.startX),
      );
      onColumnWidthChange(active.columnId, width);
    };
    const stopResize = (): void => {
      resizeRef.current = undefined;
      document.body.classList.remove('is-resizing-column');
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResize, { passive: true });
    window.addEventListener('pointercancel', stopResize, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
  }, [onColumnWidthChange]);

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex, virtualizer]);

  const selectIndex = (index: number): void => {
    if (loading) return;
    const row = rows[index];
    if (row) onSelect(row.ref);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const current = selectedIndex < 0 ? 0 : selectedIndex;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectIndex(Math.min(rows.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectIndex(Math.max(0, current - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectIndex(rows.length - 1);
    } else if (event.key === 'Enter' && selectedIndex >= 0) {
      event.preventDefault();
      selectIndex(selectedIndex);
    }
  };

  if (rows.length === 0) {
    return loading
      ? <EmptyState Icon={LoaderCircle} title="Loading records" />
      : <EmptyState title="No records match the current query" />;
  }

  return (
    <div
      className={`data-grid-scroll${loading ? ' is-refreshing' : ''}`}
      ref={scrollRef}
      role="grid"
      aria-label="JSONL records"
      aria-rowcount={rows.length}
      aria-busy={loading}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="data-grid-header" role="row" style={{ gridTemplateColumns: template }}>
        {columns.map((column) => (
          <div
            className="data-grid-heading"
            role="columnheader"
            key={column.id}
            title={column.label}
            aria-sort={sort?.columnId === column.id ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
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
            <button
              type="button"
              className="data-grid-sort"
              aria-label={`Sort by ${column.label}`}
              title={`Sort by ${column.label}`}
              onClick={() => {
                if (sort?.columnId !== column.id) onSortChange({ columnId: column.id, direction: 'asc' });
                else if (sort.direction === 'asc') onSortChange({ columnId: column.id, direction: 'desc' });
                else onSortChange(undefined);
              }}
            >
              <span className="data-grid-heading-label">{column.label}</span>
              {sort?.columnId === column.id
                ? (sort.direction === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)
                : <ArrowDown size={11} className="sort-muted" aria-hidden />}
            </button>
            <button
              type="button"
              className="column-resizer"
              aria-label={`Resize ${column.label} column`}
              aria-valuemin={MIN_COLUMN_WIDTH}
              aria-valuemax={MAX_COLUMN_WIDTH}
              aria-valuenow={columnWidths[column.id] ?? column.width ?? undefined}
              title="Drag to resize; double-click to reset"
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
                const current = columnWidths[column.id] ?? column.width ?? 160;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  onColumnWidthChange(column.id, current + (event.key === 'ArrowLeft' ? -16 : 16));
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  onColumnWidthChange(column.id, undefined);
                }
              }}
            />
          </div>
        ))}
      </div>
      <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const selected = row.ref.ordinal === selectedOrdinal;
          return (
            <div
              className={`data-grid-row${selected ? ' is-selected' : ''}${row.problems?.length ? ' has-problem' : ''}`}
              role="row"
              aria-rowindex={item.index + 1}
              aria-selected={selected}
              key={row.ref.ordinal}
              style={{ gridTemplateColumns: template, height: item.size, transform: `translateY(${item.start}px)` }}
              onClick={() => { if (!loading) onSelect(row.ref); }}
              onDoubleClick={() => { if (!loading) onSelect(row.ref); }}
            >
              {columns.map((column) => {
                const text = getColumnText(row, column.id);
                return (
                  <div className="data-grid-cell" role="gridcell" key={column.id} title={text}>
                    {column.id === '__ordinal' && row.ref.parseState !== 'valid'
                      ? <span className="parse-dot" data-state={row.ref.parseState} aria-label={row.ref.parseState} />
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
