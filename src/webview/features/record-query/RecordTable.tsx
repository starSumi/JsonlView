import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Braces, GripVertical, LoaderCircle } from 'lucide-react';
import type { ColumnSpec, RecordRef, RowProjection, RowSort } from '@shared/types';
import { columnGridTemplate, getColumnText, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '@webview/format';
import { gridCellId, gridCellRowIndex, initialGridCell, pinActiveGridRow, reconcileGridCell, useGridFocus, type GridCell } from '@webview/use-grid-focus';
import { captureViewportAnchor, GRID_HEADER_HEIGHT, GRID_ROW_HEIGHT, isRowVisible, latestRowIndex,
  physicalRowKey, resolveViewportAnchor, rowOffset, type ViewportAnchor } from './viewport-anchor';
import { ConversationRow, conversationRowHeight } from './conversation-row';

const CONVERSATION_COLUMNS: ColumnSpec[] = [
  { id: '__ordinal', label: '#', source: 'system' },
  { id: '__conversation', label: 'Conversation · all records', source: 'profile' },
];

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
  displayMode?: 'table' | 'conversation';
  selectedOrdinal?: string | undefined;
  loading: boolean;
  emptyTitle?: string | undefined;
  onSelect: (ref: RecordRef) => void;
  columnWidths: Record<string, number>;
  onColumnWidthChange: (columnId: string, width: number | undefined) => void;
  sort?: RowSort | undefined;
  onColumnOrderChange: (order: string[]) => void;
  followMode?: boolean;
  viewportMode?: 'following' | 'reading';
  viewportRevision?: number;
  latestGeneration?: string | undefined;
  latestSeq?: string | undefined;
  onReadingAnchor?: (ref?: RecordRef) => void;
  onViewportAnchor?: (ref: RecordRef) => void;
  onTailVisible?: (ref: RecordRef) => void;
  onManualTailVisible?: (ref: RecordRef) => boolean;
  gridFocusBridgeRef?: React.MutableRefObject<GridFocusBridge | undefined>;
}

export interface GridFocusBridge {
  readonly generation?: string | undefined;
  capture: () => GridCell | undefined;
  restore: (cell: GridCell | undefined) => boolean;
}

export function RecordTable({
  sessionId = 'jsonl-view',
  rows,
  columns: tableColumns,
  displayMode = 'table',
  selectedOrdinal,
  loading,
  emptyTitle,
  onSelect,
  columnWidths,
  onColumnWidthChange,
  sort,
  onColumnOrderChange,
  followMode = false,
  viewportMode = 'following',
  viewportRevision = 0,
  latestGeneration,
  latestSeq,
  onReadingAnchor,
  onViewportAnchor,
  onTailVisible,
  onManualTailVisible,
  gridFocusBridgeRef,
}: RecordTableProps): React.JSX.Element {
  const compact = displayMode === 'conversation';
  const columns = compact ? CONVERSATION_COLUMNS : tableColumns;
  const heights = useMemo(() => compact ? rows.map(conversationRowHeight) : undefined, [compact, rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const resizersRef = useRef(new Map<string, HTMLButtonElement>());
  const pointerFocusRef = useRef(false);
  const anchorRef = useRef<ViewportAnchor | undefined>(undefined);
  const geometryRef = useRef({ displayMode, rows, heights });
  if (geometryRef.current.displayMode !== displayMode && scrollRef.current) {
    anchorRef.current = captureViewportAnchor(sessionId, geometryRef.current.rows,
      scrollRef.current.scrollTop, geometryRef.current.heights);
  }
  geometryRef.current = { displayMode, rows, heights };
  const interactionPausedRef = useRef(false);
  const manualFollowingRef = useRef(false);
  const manualIntentRef = useRef<{ rows: RowProjection[]; sessionId: string; revision: number; scrollTop: number } | undefined>(undefined);
  const manualFrameRef = useRef<number | undefined>(undefined);
  const pointerInteractionRef = useRef(false);
  const scrollContextRef = useRef({ rows, sessionId, revision: viewportRevision });
  scrollContextRef.current = { rows, sessionId, revision: viewportRevision };
  const previousModeRef = useRef({ sessionId, followMode, viewportMode });
  const programmaticScrollRef = useRef<number | undefined>(undefined);
  const reportedTailRef = useRef<string | undefined>(undefined);
  const preservedSelectionRef = useRef<string | undefined>(undefined);
  const committedViewportRef = useRef({ sessionId, revision: viewportRevision, rows, selectedOrdinal });
  const previousMode = previousModeRef.current;
  if (previousMode.sessionId !== sessionId || previousMode.followMode !== followMode
    || previousMode.viewportMode !== viewportMode) {
    if (previousMode.sessionId !== sessionId) anchorRef.current = undefined;
    interactionPausedRef.current = viewportMode === 'reading';
    manualFollowingRef.current = false;
    reportedTailRef.current = undefined;
    previousModeRef.current = { sessionId, followMode, viewportMode };
  }
  const [measuredWidths, setMeasuredWidths] = useState<Record<string, number>>({});
  const focus = useGridFocus({ sessionId, rows, columns, selectedOrdinal });
  const activeIndex = gridCellRowIndex(focus.activeCell, rows);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => heights?.[index] ?? GRID_ROW_HEIGHT,
    overscan: 10,
    scrollMargin: GRID_HEADER_HEIGHT,
    scrollPaddingStart: GRID_HEADER_HEIGHT,
    getItemKey: (index) => rows[index] ? sessionId + ':' + displayMode + ':' + (heights?.[index] ?? GRID_ROW_HEIGHT) + ':' + physicalRowKey(rows[index]!.ref) : index,
    rangeExtractor: (range) => pinActiveGridRow(defaultRangeExtractor(range), activeIndex, rows.length),
  });
  const selectedIndex = rows.findIndex((row) => row.ref.ordinal === selectedOrdinal);
  const selectedRecordKey = rows[selectedIndex] === undefined ? undefined : [
    sessionId,
    rows[selectedIndex]!.ref.generation,
    rows[selectedIndex]!.ref.ordinal,
    rows[selectedIndex]!.ref.byteStart,
    rows[selectedIndex]!.ref.byteEndExclusive,
    rows[selectedIndex]!.ref.contentByteLength,
    rows[selectedIndex]!.ref.delimiterByteLength,
  ].join(':');
  const template = useMemo(() => compact ? '64px minmax(0, 1fr)' : columnGridTemplate(columns, columnWidths), [columnWidths, columns, compact]);
  const resizeRef = useRef<{ columnId: string; startX: number; startWidth: number } | undefined>(undefined);
  const dragColumnRef = useRef<string | undefined>(undefined);

  const isFollowing = useCallback((): boolean => followMode && (viewportMode === 'following' || manualFollowingRef.current)
    && !interactionPausedRef.current, [followMode, viewportMode]);
  const captureAnchor = useCallback((): ViewportAnchor | undefined => {
    const grid = scrollRef.current;
    return grid ? captureViewportAnchor(sessionId, rows, grid.scrollTop, heights) : undefined;
  }, [sessionId, rows, heights]);
  const pauseForInteraction = (): void => {
    programmaticScrollRef.current = undefined;
    anchorRef.current = captureAnchor();
    if (!followMode) return;
    manualFollowingRef.current = false;
    if (!interactionPausedRef.current) {
      interactionPausedRef.current = true;
      reportedTailRef.current = undefined;
      onReadingAnchor?.(anchorRef.current?.ref);
    }
  };
  const visibleTail = useCallback((): RecordRef | undefined => {
    if (loading) return undefined;
    const grid = scrollRef.current;
    const index = latestRowIndex(rows, latestGeneration, latestSeq, sort);
    const row = rows[index];
    if (!grid || !row || !isRowVisible(index, grid.scrollTop, grid.clientHeight, heights)) return undefined;
    const mounted = [...grid.querySelectorAll<HTMLElement>('[data-row-ordinal]')].find((element) =>
      element.dataset.rowOrdinal === row.ref.ordinal && element.dataset.rowGeneration === row.ref.generation);
    if (!mounted) return undefined;
    const viewport = grid.getBoundingClientRect();
    const bounds = mounted.getBoundingClientRect();
    if (bounds.top < viewport.top + GRID_HEADER_HEIGHT - 1 || bounds.bottom > viewport.bottom + 1) return undefined;
    return row.ref;
  }, [loading, rows, latestGeneration, latestSeq, sort, heights]);
  const reportTail = useCallback((): void => {
    const ref = visibleTail();
    if (!ref) { reportedTailRef.current = undefined; return; }
    if (!isFollowing()) return;
    const key = `${ref.generation}:${latestSeq}:${physicalRowKey(ref)}`;
    if (reportedTailRef.current === key) return;
    reportedTailRef.current = key;
    onTailVisible?.(ref);
  }, [isFollowing, latestSeq, visibleTail, onTailVisible]);
  const tryManualTail = (): void => {
    const intent = manualIntentRef.current;
    const context = scrollContextRef.current;
    if (!followMode || isFollowing() || !intent || intent.rows !== rows || context.rows !== rows
      || intent.sessionId !== sessionId || intent.revision !== viewportRevision
      || intent.sessionId !== context.sessionId || intent.revision !== context.revision
      || programmaticScrollRef.current !== undefined || pointerInteractionRef.current
      || resizeRef.current || dragColumnRef.current) return;
    const grid = scrollRef.current;
    if (!grid || grid.ownerDocument.getSelection()?.isCollapsed === false
      || grid.ownerDocument.activeElement?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]')) return;
    const ref = visibleTail();
    if (!ref || !onManualTailVisible?.(ref)) return;
    manualIntentRef.current = undefined;
    manualFollowingRef.current = true;
    interactionPausedRef.current = false;
    anchorRef.current = undefined;
    reportTail();
  };
  const armManualScroll = (): void => {
    if (manualFrameRef.current !== undefined) cancelAnimationFrame(manualFrameRef.current);
    manualFrameRef.current = undefined;
    programmaticScrollRef.current = undefined;
    manualIntentRef.current = { rows, sessionId, revision: viewportRevision, scrollTop: scrollRef.current?.scrollTop ?? 0 };
  };
  const suppressManualScroll = useCallback((): void => {
    manualIntentRef.current = undefined;
    if (manualFrameRef.current !== undefined) cancelAnimationFrame(manualFrameRef.current);
    manualFrameRef.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const grid = scrollRef.current;
    if (!grid || loading) return;
    const previous = committedViewportRef.current;
    const navigationCommitted = previous.sessionId === sessionId && previous.revision !== viewportRevision;
    const rowsReplaced = previous.rows !== rows;
    const historicalAnchor = resolveViewportAnchor(anchorRef.current, sessionId, rows, heights);
    committedViewportRef.current = { sessionId, revision: viewportRevision, rows, selectedOrdinal };
    if (navigationCommitted && !isFollowing()) {
      // An accepted explicit query/page owns its new origin, even if the old
      // physical reading record happens to be present on the new page.
      anchorRef.current = captureViewportAnchor(sessionId, rows, 0, heights);
      manualIntentRef.current = undefined;
      programmaticScrollRef.current = 0;
      preservedSelectionRef.current = selectedRecordKey;
      virtualizer.scrollToOffset(0);
    }
    let frame: number | undefined;
    const maintainViewport = (resized = false): void => {
      if (resized) {
        manualIntentRef.current = undefined;
        programmaticScrollRef.current = grid.scrollTop;
      }
      if (isFollowing()) {
        const index = latestRowIndex(rows, latestGeneration, latestSeq, sort);
        if (index < 0) return;
        const top = sort?.direction === 'desc' ? 0
          : Math.max(0, GRID_HEADER_HEIGHT + rowOffset(rows.length, heights) - grid.clientHeight);
        programmaticScrollRef.current = top;
        manualIntentRef.current = undefined;
        virtualizer.scrollToIndex(index, { align: sort?.direction === 'desc' ? 'start' : 'end' });
      } else {
        anchorRef.current ??= captureAnchor();
        const resolved = resolveViewportAnchor(anchorRef.current, sessionId, rows, heights);
        if (resolved) {
          anchorRef.current = resolved.anchor;
          if (!followMode && rowsReplaced && previous.sessionId === sessionId && historicalAnchor
            && previous.selectedOrdinal === selectedOrdinal) {
            // Rebuilding the same selection must not reveal it over the
            // physical reading position restored by this layout.
            preservedSelectionRef.current = selectedRecordKey;
          }
          const top = Math.min(resolved.scrollTop, Math.max(0, grid.scrollHeight - grid.clientHeight));
          const reposition = Math.abs(grid.scrollTop - top) > 1;
          if (rowsReplaced || reposition) {
            // DOM clamping may already have reached this target; its delayed
            // scroll still belongs to restoration, not a new reading anchor.
            programmaticScrollRef.current = top;
            manualIntentRef.current = undefined;
          }
          if (reposition) {
            virtualizer.scrollToOffset(top);
          }
          const visible = captureViewportAnchor(sessionId, rows, top, heights);
          if (visible) onViewportAnchor?.(visible.ref);
        }
      }
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        reportTail();
      });
    };
    maintainViewport();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => maintainViewport(true));
    observer?.observe(grid);
    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [sessionId, rows, followMode, viewportRevision, latestGeneration, latestSeq, loading, sort, selectedOrdinal, selectedRecordKey,
    virtualizer, onViewportAnchor, captureAnchor, reportTail, isFollowing, heights]);

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
      pointerInteractionRef.current = false;
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
      if (manualFrameRef.current !== undefined) cancelAnimationFrame(manualFrameRef.current);
    };
  }, [onColumnWidthChange]);

  useEffect(() => {
    if (selectedRecordKey === undefined) preservedSelectionRef.current = undefined;
    if (!followMode && selectedRecordKey !== undefined && selectedIndex >= 0
      && preservedSelectionRef.current !== selectedRecordKey) {
      preservedSelectionRef.current = undefined;
      programmaticScrollRef.current = undefined;
      virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
    }
  }, [selectedIndex, selectedRecordKey, virtualizer, followMode]);

  const revealCell = useCallback((cell: GridCell | undefined): void => {
    suppressManualScroll();
    const index = gridCellRowIndex(cell, rows);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
    else if (cell?.kind === 'header') scrollRef.current?.scrollTo({ top: 0 });
  }, [rows, suppressManualScroll, virtualizer]);
  useLayoutEffect(() => {
    if (gridFocusBridgeRef === undefined) return;
    if (scrollRef.current === null) {
      gridFocusBridgeRef.current = undefined;
      return;
    }
    const restore = (cell: GridCell | undefined): boolean => {
      const next = cell === undefined
        ? initialGridCell({ sessionId, rows, columns, selectedOrdinal })
        : reconcileGridCell(cell, { sessionId, rows, columns });
      if (next === undefined) return false;
      focus.setActiveCell(next);
      revealCell(next);
      scrollRef.current?.focus({ preventScroll: true });
      return true;
    };
    const bridge: GridFocusBridge = {
      generation: rows[0]?.ref.generation,
      capture: () => focus.activeCell ?? focus.enter(),
      restore,
    };
    gridFocusBridgeRef.current = bridge;
    return () => {
      if (gridFocusBridgeRef.current === bridge) gridFocusBridgeRef.current = undefined;
    };
  }, [columns, focus, gridFocusBridgeRef, revealCell, rows, selectedOrdinal, sessionId]);
  const clearPointerFocus = (): void => {
    pointerFocusRef.current = false;
    pointerInteractionRef.current = false;
  };

  const activateRow = (row: RowProjection, columnId = columns[0]?.id): void => {
    if (loading) return;
    pauseForInteraction();
    if (columnId !== undefined) {
      focus.setActiveCell({ kind: 'data', sessionId, generation: row.ref.generation,
        ordinal: row.ref.ordinal, columnId });
    }
    scrollRef.current?.focus({ preventScroll: true });
    onSelect(row.ref);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (loading || event.target !== event.currentTarget || event.altKey || event.metaKey) return;
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      pauseForInteraction();
      armManualScroll();
    }
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      pauseForInteraction();
      event.preventDefault();
      revealCell(focus.move(event.key, event.ctrlKey));
    } else if (event.key === 'Enter' || event.key === ' ') {
      pauseForInteraction();
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
      : <EmptyState title={emptyTitle ?? 'No records match the current query'} />;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualized absolute-positioned CSS grid requires ARIA grid semantics
    <div
      className={`data-grid-scroll${loading ? ' is-refreshing' : ''}`}
      ref={scrollRef}
      role="grid"
      aria-label="JSONL records"
      data-display-mode={displayMode}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      aria-busy={loading}
      aria-activedescendant={activeDescendant}
      aria-description="Arrow keys move cell focus. Enter or Space opens a record. Enter on a header enables column resizing."
      tabIndex={0}
      style={{ overflowAnchor: 'none' }}
      onWheelCapture={(event) => {
        if (event.ctrlKey) return;
        const towardTail = sort?.direction === 'desc' ? event.deltaY < 0 : event.deltaY > 0;
        if (event.deltaX !== 0 || (!towardTail && event.deltaY !== 0)) pauseForInteraction();
        if (event.deltaX !== 0 || event.deltaY === 0) { suppressManualScroll(); return; }
        armManualScroll();
        if (towardTail && onManualTailVisible && !isFollowing()) {
          if (manualFrameRef.current !== undefined) cancelAnimationFrame(manualFrameRef.current);
          manualFrameRef.current = requestAnimationFrame(() => {
            manualFrameRef.current = undefined;
            tryManualTail();
          });
        }
      }}
      onTouchStartCapture={() => { pauseForInteraction(); armManualScroll(); }}
      onPointerDownCapture={(event) => {
        pointerFocusRef.current = true;
        pauseForInteraction();
        pointerInteractionRef.current = event.pointerType !== 'touch' && event.target !== event.currentTarget;
        if (!pointerInteractionRef.current) armManualScroll();
        else suppressManualScroll();
      }}
      onPointerUpCapture={clearPointerFocus}
      onPointerCancelCapture={clearPointerFocus}
      onPointerLeave={() => { pointerFocusRef.current = false; }}
      onFocus={(event) => {
        // Pointer focus on the gutter or virtual space must not reveal a default row.
        const pointerEntry = pointerFocusRef.current;
        pointerFocusRef.current = false;
        if (!loading && !pointerEntry && event.target === event.currentTarget
          && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          pauseForInteraction();
          revealCell(focus.enter());
        }
      }}
      onKeyDown={handleKeyDown}
      onScroll={() => {
        const grid = scrollRef.current;
        if (!grid || loading || committedViewportRef.current.rows !== rows) return;
        const expected = programmaticScrollRef.current;
        if (expected !== undefined) {
          reportTail();
          return;
        }
        if (!followMode) {
          anchorRef.current = captureAnchor();
          if (anchorRef.current) onViewportAnchor?.(anchorRef.current.ref);
          return;
        }
        const intent = manualIntentRef.current;
        const deltaY = intent ? grid.scrollTop - intent.scrollTop : 0;
        if (intent) intent.scrollTop = grid.scrollTop;
        if (isFollowing()) {
          const index = latestRowIndex(rows, latestGeneration, latestSeq, sort);
          if (!isRowVisible(index, grid.scrollTop, grid.clientHeight, heights)) pauseForInteraction();
        }
        if (!isFollowing()) {
          anchorRef.current = captureAnchor();
          if (anchorRef.current) onViewportAnchor?.(anchorRef.current.ref);
        }
        if (sort?.direction === 'desc' ? deltaY < 0 : deltaY > 0) tryManualTail();
        reportTail();
      }}
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
            draggable={!compact && column.id !== '__ordinal'}
            onDragStart={(event) => {
              if (compact || column.id === '__ordinal') {
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
            {!compact && column.id !== '__ordinal' ? <GripVertical size={11} className="column-drag-handle" aria-hidden /> : null}
            <span className="data-grid-heading-label">{column.label}</span>
            {/* biome-ignore lint/a11y/useSemanticElements: the column resizer is an interactive separator button */}
            {!compact ? <button
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
            /> : null}
          </div>
        ); })}
      </div>
      <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const selected = row.ref.ordinal === selectedOrdinal;
          return (
            // biome-ignore lint/a11y/useSemanticElements: virtualized absolute-positioned CSS grid row cannot be a native table row
            // biome-ignore lint/a11y/useKeyWithClickEvents: grid keyboard activation is owned by the parent active-descendant model
            <div
              className={`data-grid-row${selected ? ' is-selected' : ''}${row.problems?.length ? ' has-problem' : ''}`}
              role="row"
              aria-rowindex={item.index + 2}
              aria-selected={selected}
              tabIndex={-1}
              key={`${sessionId}:${physicalRowKey(row.ref)}`}
              data-row-ordinal={row.ref.ordinal}
              data-row-generation={row.ref.generation}
              onClick={(event) => {
                // Cell clicks own their active-cell semantics; the row handler
                // covers the virtual row background/gutter only.
                if (event.target !== event.currentTarget) return;
                activateRow(row);
              }}
              style={{ gridTemplateColumns: template, height: item.size, transform: `translateY(${item.start - GRID_HEADER_HEIGHT}px)` }}
            >
              {columns.map((column, columnIndex) => {
                const text = getColumnText(row, column.id);
                const active = activeCell?.kind === 'data' && activeCell.generation === row.ref.generation
                  && activeCell.ordinal === row.ref.ordinal && activeCell.columnId === column.id;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: virtualized CSS grid cell cannot be a native table cell
                  <div
                    className={`data-grid-cell${active ? ' is-active-cell' : ''}`}
                    role="gridcell"
                    id={gridCellId(sessionId, row.ref.generation, row.ref.ordinal, column.id)}
                    aria-colindex={columnIndex + 1}
                    tabIndex={-1}
                    key={column.id}
                    title={text}
                    onClick={() => { activateRow(row, column.id); }}
                    onKeyDown={(event) => {
                      if (loading || (event.key !== 'Enter' && event.key !== ' ')) return;
                      event.preventDefault();
                      activateRow(row, column.id);
                    }}
                  >
                    {column.id === '__ordinal' && row.ref.parseState !== 'valid'
                      ? <span className="parse-dot" data-state={row.ref.parseState} role="img" aria-label={row.ref.parseState} />
                      : null}
                    {column.id === '__conversation' ? <ConversationRow row={row} />
                      : <span className="cell-text">{text || (column.id === '__ordinal' ? row.ref.ordinal : '')}</span>}
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
