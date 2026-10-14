import type React from 'react';
import { useEffect, useLayoutEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RowProjection } from '../../src/shared/types';
import { RecordTable, type RecordTableProps } from '../../src/webview/features/record-query/RecordTable';
import { gridCellId, type GridCell } from '../../src/webview/use-grid-focus';

const gridState = vi.hoisted(() => ({
  cell: undefined as GridCell | undefined,
  persistentRefs: false,
  refCursor: 0,
  refs: [] as Array<{ current: unknown }>,
  items: [0, 1].map((index) => ({ index, key: index, start: 30 + index * 30, size: 30 })),
}));

const virtualizer = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  getTotalSize: () => 60,
  getVirtualItems: () => gridState.items,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(() => virtualizer),
  defaultRangeExtractor: (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
    const start = Math.max(0, range.startIndex - range.overscan);
    const end = Math.min(range.count - 1, range.endIndex + range.overscan);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  },
}));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
  useState: <Value>(initial?: Value): [Value | undefined, ReturnType<typeof vi.fn>] => [
    initial === undefined ? gridState.cell as Value : initial, vi.fn(),
  ],
  useMemo: <Value>(factory: () => Value): Value => factory(),
  useCallback: <Value>(callback: Value): Value => callback,
  useRef: <Value>(current: Value): { current: Value } => {
    if (!gridState.persistentRefs) return { current };
    const index = gridState.refCursor++;
    gridState.refs[index] ??= { current };
    return gridState.refs[index] as { current: Value };
  },
}));

function render(overrides: Partial<RecordTableProps> = {}) {
  gridState.refCursor = 0;
  const onSelect = vi.fn();
  const rows: RowProjection[] = ['0', '1'].map((ordinal) => ({
    ref: { generation: 'g1', ordinal, byteStart: '0', byteEndExclusive: '3',
      contentByteLength: '2', delimiterByteLength: 1, parseState: 'valid' },
    cells: [],
    genericSummary: 'Synthetic record',
  }));
  const element = RecordTable({
    sessionId: 'synthetic-document', rows,
    columns: [{ id: '__ordinal', label: '#', source: 'system' }, { id: 'status', label: 'Status', source: 'profile' }],
    selectedOrdinal: '0', loading: false, onSelect,
    columnWidths: {}, onColumnWidthChange: vi.fn(),
    onColumnOrderChange: vi.fn(), ...overrides,
  }) as React.ReactElement<React.HTMLAttributes<HTMLDivElement>>;
  const press = (key: string, ctrlKey = false): void => {
    element.props.onKeyDown?.({ key, ctrlKey, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLDivElement>);
  };
  return { element, press, onSelect, rows };
}

describe('record table selection visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    virtualizer.scrollToOffset.mockReset();
    gridState.cell = undefined;
    gridState.persistentRefs = false;
    gridState.refs = [];
    gridState.items = [0, 1].map((index) => ({ index, key: index, start: 30 + index * 30, size: 30 }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('accounts for the sticky header in virtual rows and scroll targets', () => {
    render();
    expect(vi.mocked(useVirtualizer)).toHaveBeenCalledWith(expect.objectContaining({
      scrollMargin: 30,
      scrollPaddingStart: 30,
    }));
  });

  it('announces the active row order without per-column sort buttons', () => {
    type HeaderElement = React.ReactElement<{
      children: HeaderElement[];
      className?: string;
      'aria-sort'?: string;
    }>;
    const { element } = render({
      columns: [
        { id: '__ordinal', label: '#', source: 'system' },
        { id: 'status', label: 'Status', source: 'profile' },
      ],
      sort: { columnId: '__ordinal', direction: 'desc' },
    });
    const [header] = element.props.children as HeaderElement[];
    const headings = header!.props.children;
    expect(headings.map((heading) => heading.props['aria-sort'])).toEqual(['descending', undefined]);
    for (const heading of headings) {
      expect(heading.props.children.some((child) => child?.props.className === 'data-grid-sort')).toBe(false);
    }
  });

  it('reveals a different physical record at the same page-local index', () => {
    const { rows } = render();
    const nextRows = rows.map((row, index) => ({
      ...row, ref: { ...row.ref, ordinal: String(20 + index) },
    }));
    render({ rows: nextRows, selectedOrdinal: '20' });
    const [reveal, dependencies] = vi.mocked(useEffect).mock.calls.at(-1)!;
    expect(dependencies).toEqual([0, 'synthetic-document:g1:20:0:3:2:1', virtualizer, false]);
    reveal();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
  });

  it('reveals a replacement generation at the same ordinal and index', () => {
    const { rows } = render();
    const replacementRows = rows.map((row) => ({
      ...row, ref: { ...row.ref, generation: 'g2' },
    }));
    render({ rows: replacementRows });
    const [reveal, dependencies] = vi.mocked(useEffect).mock.calls.at(-1)!;
    expect(dependencies).toEqual([0, 'synthetic-document:g2:0:0:3:2:1', virtualizer, false]);
    reveal();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
  });

  it('reveals a different document at the same ordinal and index', () => {
    render({ sessionId: 'another-synthetic-document' });
    const [reveal, dependencies] = vi.mocked(useEffect).mock.calls.at(-1)!;
    expect(dependencies).toEqual([0, 'another-synthetic-document:g1:0:0:3:2:1', virtualizer, false]);
    reveal();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
  });

  it('moves Home to the first column without activating a record', () => {
    const { press, onSelect } = render();
    press('Home');
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not reveal selection when Follow owns the viewport, including a replacement generation', () => {
    const { rows } = render();
    render({ followMode: true, viewportMode: 'reading', rows: rows.map((row) => ({ ...row, ref: { ...row.ref, generation: 'g2' } })) });
    const [reveal] = vi.mocked(useEffect).mock.calls.at(-1)!;
    reveal();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
  });

  it.each(['onWheelCapture', 'onTouchStartCapture', 'onPointerDownCapture'] as const)(
    'pauses Follow synchronously for %s without opening any record', (handler) => {
      const onReadingAnchor = vi.fn();
      const onTailVisible = vi.fn();
      const { element, onSelect } = render({ followMode: true, viewportMode: 'following', onReadingAnchor, onTailVisible });
      const interact = element.props[handler] as ((event: { deltaY: number; deltaX: number }) => void);
      interact({ deltaY: -1, deltaX: 0 });
      interact({ deltaY: -1, deltaX: 0 });
      expect(onReadingAnchor).toHaveBeenCalledOnce();
      expect(onSelect).not.toHaveBeenCalled();
      expect(onTailVisible).not.toHaveBeenCalled();
    },
  );

  it('keeps End as grid navigation and pauses Follow without activating a row', () => {
    const onReadingAnchor = vi.fn();
    const { press, onSelect } = render({ followMode: true, viewportMode: 'following', onReadingAnchor });
    press('End', true);
    expect(onReadingAnchor).toHaveBeenCalledOnce();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(1, { align: 'auto' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('reports the newest row only after it is mounted and visible below the header', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', undefined);
    const onTailVisible = vi.fn();
    const { element, rows, onSelect } = render({ followMode: true, viewportMode: 'following', latestGeneration: 'g1',
      latestSeq: '2', onTailVisible });
    type GridElement = React.ReactElement<React.HTMLAttributes<HTMLDivElement> & { ref: { current: HTMLDivElement | null } }>;
    const root = element as GridElement;
    root.props.ref.current = { scrollTop: 0, clientHeight: 120, scrollHeight: 90,
      querySelectorAll: () => [{ dataset: { rowOrdinal: '1', rowGeneration: 'g1' },
        getBoundingClientRect: () => ({ top: 60, bottom: 90 }) }],
      getBoundingClientRect: () => ({ top: 0, bottom: 120 }),
    } as unknown as HTMLDivElement;
    const [layout] = vi.mocked(useLayoutEffect).mock.calls.find(([, dependencies]) => dependencies?.includes('2'))!;
    const cleanup = layout();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: 'end' });
    expect(onTailVisible).not.toHaveBeenCalled();
    frame?.(0);
    expect(onTailVisible).toHaveBeenCalledExactlyOnceWith(rows[1]!.ref);
    expect(onSelect).not.toHaveBeenCalled();
    if (typeof cleanup === 'function') cleanup();
    vi.unstubAllGlobals();
  });

  it.each([0, 60])('does not report a newest row outside a viewport of height %s', (clientHeight) => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', undefined);
    const onTailVisible = vi.fn();
    const { element } = render({ followMode: true, latestGeneration: 'g1', latestSeq: '2', onTailVisible });
    type GridElement = React.ReactElement<React.HTMLAttributes<HTMLDivElement> & { ref: { current: HTMLDivElement | null } }>;
    const root = element as GridElement;
    root.props.ref.current = { scrollTop: 0, clientHeight, scrollHeight: 90,
      querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, bottom: clientHeight }),
    } as unknown as HTMLDivElement;
    const [layout] = vi.mocked(useLayoutEffect).mock.calls.find(([, dependencies]) => dependencies?.includes('2'))!;
    const cleanup = layout();
    frame?.(0);
    expect(onTailVisible).not.toHaveBeenCalled();
    if (typeof cleanup === 'function') cleanup();
    vi.unstubAllGlobals();
  });

  it('captures a physical reading record on wheel input before any source update', () => {
    const onReadingAnchor = vi.fn();
    const { element, rows } = render({ followMode: true, onReadingAnchor });
    type GridElement = React.ReactElement<React.HTMLAttributes<HTMLDivElement> & { ref: { current: HTMLDivElement | null } }>;
    const root = element as GridElement;
    root.props.ref.current = { scrollTop: 37 } as HTMLDivElement;
    root.props.onWheelCapture?.({ deltaY: -1, deltaX: 0 } as React.WheelEvent<HTMLDivElement>);
    expect(onReadingAnchor).toHaveBeenCalledExactlyOnceWith(rows[1]!.ref);
  });

  it('keeps Following for a wheel directed toward the tail and pauses when moving away in either row order', () => {
    const onReadingAnchor = vi.fn();
    const { element } = render({ followMode: true, onReadingAnchor });
    element.props.onWheelCapture?.({ deltaY: 1, deltaX: 0 } as React.WheelEvent<HTMLDivElement>);
    expect(onReadingAnchor).not.toHaveBeenCalled();
    const { element: descending } = render({ followMode: true, sort: { columnId: '__ordinal', direction: 'desc' }, onReadingAnchor });
    descending.props.onWheelCapture?.({ deltaY: -1, deltaX: 0 } as React.WheelEvent<HTMLDivElement>);
    expect(onReadingAnchor).not.toHaveBeenCalled();
    descending.props.onWheelCapture?.({ deltaY: 1, deltaX: 0 } as React.WheelEvent<HTMLDivElement>);
    expect(onReadingAnchor).toHaveBeenCalledOnce();
  });

  it('starts an accepted explicit page at its origin when the old reading record is also on that page', () => {
    gridState.persistentRefs = true;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', undefined);
    const page = (start: number, generation = 'g1'): RowProjection[] => Array.from({ length: 100 }, (_, index) => ({
      ref: { generation, ordinal: String(start + index), byteStart: String((start + index) * 10),
        byteEndExclusive: String((start + index) * 10 + 10), contentByteLength: '9',
        delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: 'Synthetic record',
    }));
    const onViewportAnchor = vi.fn();
    const focusGrid = vi.fn();
    const grid = { scrollTop: (87 - 21) * 30 + 7, clientHeight: 120, scrollHeight: 3030,
      focus: focusGrid } as unknown as HTMLDivElement;
    virtualizer.scrollToOffset.mockImplementation((offset: number) => { grid.scrollTop = offset; });
    type GridElement = React.ReactElement<React.HTMLAttributes<HTMLDivElement> & { ref: { current: HTMLDivElement | null } }>;
    const commit = (rows: RowProjection[], revision: number, loading = false): GridElement => {
      const { element } = render({ rows, followMode: true, viewportMode: 'reading', viewportRevision: revision,
        selectedOrdinal: '87', latestSeq: '121', loading, onViewportAnchor });
      const root = element as GridElement;
      root.props.ref.current = grid;
      const [layout] = [...vi.mocked(useLayoutEffect).mock.calls].reverse().find(([, dependencies]) => dependencies?.includes('121'))!;
      const cleanup = layout();
      if (typeof cleanup === 'function') cleanup();
      return root;
    };
    const original = commit(page(21), 0);
    expect(onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('87');
    expect(virtualizer.scrollToOffset).not.toHaveBeenCalled();

    // Loading keeps the old rows and position; the revision is consumed only
    // when the accepted response renders its new page.
    commit(page(21), 1, true);
    expect(grid.scrollTop).toBe(1987);
    expect(virtualizer.scrollToOffset).not.toHaveBeenCalled();

    const navigated = commit(page(0, 'g2'), 1);
    expect(virtualizer.scrollToOffset).toHaveBeenCalledExactlyOnceWith(0);
    expect(onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('0');
    expect(onViewportAnchor.mock.calls.at(-1)?.[0].generation).toBe('g2');
    expect(grid.scrollTop).toBe(0);
    expect(navigated.props.ref).toBe(original.props.ref);
    expect(navigated.props.ref.current).toBe(grid);
    expect(focusGrid).not.toHaveBeenCalled();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    commit(page(0, 'g3'), 1);
    expect(virtualizer.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('0');
    virtualizer.scrollToOffset.mockReset();
    vi.unstubAllGlobals();
  });

  it('preserves a reading record and offset when source recovery changes rows without an explicit viewport revision', () => {
    gridState.persistentRefs = true;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', undefined);
    const page = (start: number, generation: string): RowProjection[] => Array.from({ length: 100 }, (_, index) => ({
      ref: { generation, ordinal: String(start + index), byteStart: String((start + index) * 10),
        byteEndExclusive: String((start + index) * 10 + 10), contentByteLength: '9',
        delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: 'Synthetic record',
    }));
    const grid = { scrollTop: 1987, clientHeight: 120, scrollHeight: 3030 } as HTMLDivElement;
    const onViewportAnchor = vi.fn();
    virtualizer.scrollToOffset.mockImplementation((offset: number) => { grid.scrollTop = offset; });
    type GridElement = React.ReactElement<React.HTMLAttributes<HTMLDivElement> & { ref: { current: HTMLDivElement | null } }>;
    for (const rows of [page(21, 'g1'), page(22, 'g2')]) {
      const { element } = render({ rows, followMode: true, viewportMode: 'reading', viewportRevision: 0,
        latestSeq: '122', onViewportAnchor });
      (element as GridElement).props.ref.current = grid;
      const [layout] = [...vi.mocked(useLayoutEffect).mock.calls].reverse().find(([, dependencies]) => dependencies?.includes('122'))!;
      const cleanup = layout();
      if (typeof cleanup === 'function') cleanup();
    }
    expect(virtualizer.scrollToOffset).toHaveBeenCalledExactlyOnceWith(1957);
    expect(grid.scrollTop).toBe((87 - 22) * 30 + 7);
    expect(onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('87');
    expect(onViewportAnchor.mock.calls.at(-1)?.[0].generation).toBe('g2');
    virtualizer.scrollToOffset.mockReset();
    vi.unstubAllGlobals();
  });

  function manualTailFixture(overrides: Partial<RecordTableProps> = {}) {
    gridState.persistentRefs = true;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const observers = new Set<ResizeObserverCallback>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) { observers.add(callback); }
      observe(): void {}
      disconnect(): void { observers.delete(this.callback); }
    });
    const page = (count = 3, generation = 'g1', start = 0): RowProjection[] => Array.from({ length: count }, (_, index) => ({
      ref: { generation, ordinal: String(start + index), byteStart: String((start + index) * 10), byteEndExclusive: String((start + index) * 10 + 10),
        contentByteLength: '9', delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: 'Synthetic record',
    }));
    let mounted = true;
    let collapsed = true;
    let editable = false;
    let currentRows = overrides.rows ?? page();
    const onManualTailVisible = vi.fn(() => true);
    const onTailVisible = vi.fn();
    const onViewportAnchor = vi.fn();
    const ownerDocument = { getSelection: () => ({ isCollapsed: collapsed }),
      activeElement: { closest: () => editable ? {} : null } };
    const grid = { scrollTop: 0, scrollLeft: 0, clientHeight: 90, scrollHeight: 120, ownerDocument, contains: () => false,
      querySelectorAll: () => mounted ? currentRows.map((row, index) => ({
        dataset: { rowOrdinal: row.ref.ordinal, rowGeneration: row.ref.generation },
        getBoundingClientRect: () => ({ top: 30 + index * 30 - grid.scrollTop, bottom: 60 + index * 30 - grid.scrollTop }),
      })) : [], getBoundingClientRect: () => ({ top: 0, bottom: grid.clientHeight }),
    } as unknown as HTMLDivElement;
    virtualizer.scrollToOffset.mockImplementation((offset: number) => { grid.scrollTop = offset; });
    type GridElement = React.ReactElement<React.HTMLAttributes<HTMLDivElement> & { ref: { current: HTMLDivElement | null } }>;
    const props: Partial<RecordTableProps> = { followMode: true, viewportMode: 'reading', viewportRevision: 0,
      latestGeneration: 'g1', latestSeq: '3', onManualTailVisible, onTailVisible, onViewportAnchor, ...overrides };
    let element: GridElement;
    const rerender = (changes: Partial<RecordTableProps> = {}): GridElement => {
      Object.assign(props, changes);
      currentRows = props.rows ?? currentRows;
      Object.assign(grid, { scrollHeight: 30 + currentRows.length * 30 });
      element = render({ ...props, rows: currentRows }).element as GridElement;
      if (element.props.ref) element.props.ref.current = grid;
      else gridState.refs[0]!.current = null;
      return element;
    };
    rerender();
    const flushFrames = (): void => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    };
    const wheel = (deltaY: number, deltaX = 0): void => element.props.onWheelCapture?.({ deltaY, deltaX } as React.WheelEvent<HTMLDivElement>);
    const scroll = (top: number): void => { grid.scrollTop = top; element.props.onScroll?.({} as React.UIEvent<HTMLDivElement>); };
    let layoutCleanup: (() => void) | undefined;
    const layout = (): void => {
      layoutCleanup?.();
      const [effect] = [...vi.mocked(useLayoutEffect).mock.calls].reverse()
        .find(([, dependencies]) => dependencies?.includes(props.latestSeq))!;
      const cleanup = effect();
      layoutCleanup = typeof cleanup === 'function' ? cleanup : undefined;
    };
    return { page, grid, props, rerender, flushFrames, wheel, scroll, layout, onManualTailVisible, onTailVisible, onViewportAnchor,
      selectionEffect: () => { vi.mocked(useEffect).mock.calls.at(-1)![0](); },
      element: () => element, mount: (value: boolean) => { mounted = value; },
      resize: () => { for (const observer of observers) observer([], {} as ResizeObserver); },
      selection: (value: boolean) => { collapsed = value; }, edit: (value: boolean) => { editable = value; } };
  }

  it('resumes Reading on a real user scroll to the current tail and follows the next append immediately', () => {
    const fixture = manualTailFixture();
    fixture.layout();
    fixture.wheel(1);
    fixture.scroll(30);
    expect(fixture.onManualTailVisible).toHaveBeenCalledExactlyOnceWith(fixture.page()[2]!.ref);
    expect(fixture.onTailVisible).toHaveBeenCalledExactlyOnceWith(fixture.page()[2]!.ref);
    fixture.rerender({ rows: fixture.page(4, 'g2'), latestSeq: '4', latestGeneration: 'g2' });
    fixture.layout();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(3, { align: 'end' });
  });

  it('resumes when the user wheels toward the tail while already at its boundary', () => {
    const fixture = manualTailFixture();
    fixture.grid.scrollTop = 30;
    fixture.wheel(1);
    fixture.flushFrames();
    expect(fixture.onManualTailVisible).toHaveBeenCalledOnce();
    expect(fixture.onTailVisible).toHaveBeenCalledOnce();
  });

  it('resumes a descending physical order only when the real latest row is visible at the top', () => {
    const fixture = manualTailFixture({ sort: { columnId: '__ordinal', direction: 'desc' } });
    fixture.rerender({ rows: fixture.page().reverse() });
    fixture.layout();
    fixture.grid.scrollTop = 30;
    fixture.wheel(-1);
    fixture.scroll(0);
    expect(fixture.onManualTailVisible).toHaveBeenCalledExactlyOnceWith(fixture.page()[2]!.ref);
    expect(fixture.onTailVisible).toHaveBeenCalledOnce();
  });

  it.each(['PageDown', 'scrollbar'] as const)('accepts a %s gesture that actually reaches the latest row', (gesture) => {
    const fixture = manualTailFixture();
    const element = fixture.element();
    if (gesture === 'PageDown') element.props.onKeyDown?.({ key: 'PageDown', currentTarget: fixture.grid,
      target: fixture.grid } as unknown as React.KeyboardEvent<HTMLDivElement>);
    else element.props.onPointerDownCapture?.({ currentTarget: fixture.grid,
      target: fixture.grid, pointerType: 'mouse' } as unknown as React.PointerEvent<HTMLDivElement>);
    fixture.scroll(30);
    expect(fixture.onManualTailVisible).toHaveBeenCalledOnce();
    expect(fixture.onTailVisible).toHaveBeenCalledOnce();
  });

  it.each(['one row short', 'historical page', 'stale generation', 'unmounted', 'zero height', 'other sort', 'loading'])(
    'keeps Reading for %s despite user scroll intent', (condition) => {
      const fixture = manualTailFixture();
      if (condition === 'historical page') fixture.rerender({ latestSeq: '4' });
      if (condition === 'stale generation') fixture.rerender({ latestGeneration: 'g2' });
      if (condition === 'unmounted') fixture.mount(false);
      if (condition === 'zero height') Object.assign(fixture.grid, { clientHeight: 0 });
      if (condition === 'other sort') fixture.rerender({ sort: { columnId: 'status', direction: 'asc' } });
      if (condition === 'loading') fixture.rerender({ loading: true });
      fixture.wheel(1);
      fixture.scroll(condition === 'one row short' ? 0 : 30);
      fixture.flushFrames();
      expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
      expect(fixture.onTailVisible).not.toHaveBeenCalled();
    },
  );

  it('retains Reading and its physical anchor when the controller refuses a visible tail', () => {
    const fixture = manualTailFixture();
    fixture.onManualTailVisible.mockReturnValue(false);
    fixture.wheel(1);
    fixture.scroll(30);
    expect(fixture.onManualTailVisible).toHaveBeenCalledOnce();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();
    fixture.rerender({ rows: fixture.page(4, 'g2'), latestGeneration: 'g2', latestSeq: '4' });
    fixture.layout();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('1');
  });

  it.each(['selection', 'editable', 'drag', 'drag focus', 'drag leaves grid'] as const)(
    'preserves %s interaction priority at the latest row', (interaction) => {
    const fixture = manualTailFixture();
    if (interaction === 'selection') fixture.selection(false);
    if (interaction === 'editable') fixture.edit(true);
    if (interaction.startsWith('drag')) fixture.element().props.onPointerDownCapture?.({ currentTarget: fixture.grid,
      target: {} as EventTarget, pointerType: 'mouse' } as unknown as React.PointerEvent<HTMLDivElement>);
    if (interaction === 'drag focus') fixture.element().props.onFocus?.({ currentTarget: fixture.grid,
      target: fixture.grid, relatedTarget: null } as React.FocusEvent<HTMLDivElement>);
    if (interaction === 'drag leaves grid') fixture.element().props.onPointerLeave?.({} as React.PointerEvent<HTMLDivElement>);
    fixture.wheel(1);
    fixture.scroll(30);
    fixture.flushFrames();
    expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();

  });

  it.each(['horizontal wheel', 'horizontal scrollbar'] as const)(
    'keeps Reading for %s even when the latest row is already visible', (gesture) => {
      const fixture = manualTailFixture();
      fixture.grid.scrollTop = 30;
      if (gesture === 'horizontal wheel') fixture.wheel(0, 1);
      else fixture.element().props.onPointerDownCapture?.({ currentTarget: fixture.grid,
        target: fixture.grid, pointerType: 'mouse' } as unknown as React.PointerEvent<HTMLDivElement>);
      fixture.grid.scrollLeft = 80;
      fixture.scroll(30);
      fixture.flushFrames();
      expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
      expect(fixture.onTailVisible).not.toHaveBeenCalled();
    },
  );

  it.each(['asc', 'desc'] as const)('keeps Reading after a 1 px %s scroll away from an otherwise visible tail', (direction) => {
    const fixture = manualTailFixture({ sort: { columnId: '__ordinal', direction } });
    if (direction === 'desc') fixture.rerender({ rows: fixture.page().reverse() });
    fixture.grid.scrollTop = direction === 'desc' ? 0 : 30;
    fixture.wheel(direction === 'desc' ? -1 : 1);
    // A newer gesture cancels the prior boundary frame even inside the
    // one-pixel geometric tolerance used for real layout bounds.
    fixture.wheel(direction === 'desc' ? 1 : -1);
    fixture.scroll(direction === 'desc' ? 1 : 29);
    fixture.flushFrames();
    expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();
  });

  it('does not use pre-resize intent when a resized viewport makes the tail visible', () => {
    const fixture = manualTailFixture();
    fixture.layout();
    fixture.wheel(1);
    Object.assign(fixture.grid, { clientHeight: 120 });
    fixture.resize();
    fixture.scroll(0);
    fixture.flushFrames();
    expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();
  });

  it('does not treat a delayed programmatic anchor restore as manual after the animation frame', () => {
    const fixture = manualTailFixture();
    fixture.layout();
    fixture.grid.scrollTop = 30;
    fixture.layout();
    expect(virtualizer.scrollToOffset).toHaveBeenCalledExactlyOnceWith(0);
    fixture.flushFrames();
    // A late native scroll event remains tagged even after the layout frame.
    fixture.scroll(30);
    expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();
  });

  it('does not borrow an old wheel gesture when row replacement makes a tail visible', () => {
    const fixture = manualTailFixture();
    fixture.wheel(1);
    fixture.rerender({ rows: fixture.page(3, 'g2'), latestGeneration: 'g2' });
    fixture.scroll(30);
    fixture.flushFrames();
    expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();
  });

  it('invalidates tail reporting when the user leaves and returns to the same tail', () => {
    const fixture = manualTailFixture();
    fixture.wheel(1);
    fixture.scroll(30);
    fixture.wheel(-1);
    fixture.scroll(0);
    fixture.wheel(1);
    fixture.scroll(30);
    expect(fixture.onManualTailVisible).toHaveBeenCalledTimes(2);
    expect(fixture.onTailVisible).toHaveBeenCalledTimes(2);
  });

  it('keeps the Follow-off physical record and fractional offset when Rebuild replaces a long page with a shorter window', () => {
    const fixture = manualTailFixture({ followMode: false, selectedOrdinal: '105', latestSeq: '126' });
    fixture.rerender({ rows: fixture.page(100, 'g1', 26) });
    Object.assign(fixture.grid, { clientHeight: 773 });
    fixture.layout();
    fixture.selectionEffect();
    virtualizer.scrollToIndex.mockClear();
    fixture.wheel(-1);
    fixture.scroll(2196.8);
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('99');

    // Follow off retains the old page while the summary reports an append.
    fixture.rerender({ latestSeq: '127', latestGeneration: 'g2' });
    fixture.layout();
    expect(fixture.grid.scrollTop).toBe(2196.8);
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();

    fixture.rerender({ rows: fixture.page(46, 'g2', 81) });
    // Native DOM clamping can dispatch a scroll before the replacement layout.
    fixture.scroll(636.8);
    fixture.layout();
    fixture.selectionEffect();
    expect(fixture.grid.scrollTop).toBeCloseTo(546.8, 8);
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0]).toMatchObject({ ordinal: '99', generation: 'g2' });
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();

    // A later explicit selection remains an independent navigation intent.
    fixture.rerender({ selectedOrdinal: '95' });
    fixture.layout();
    fixture.selectionEffect();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(14, { align: 'auto' });
    fixture.scroll(420);
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('95');
    fixture.rerender({ selectedOrdinal: '105' });
    fixture.layout();
    fixture.selectionEffect();
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(24, { align: 'auto' });
  });

  it('uses accepted explicit navigation as the Follow-off origin even when the old reading row overlaps', () => {
    const fixture = manualTailFixture({ followMode: false, selectedOrdinal: '87', latestSeq: '121' });
    fixture.rerender({ rows: fixture.page(100, 'g1', 21) });
    Object.assign(fixture.grid, { clientHeight: 120 });
    fixture.layout();
    fixture.wheel(-1);
    fixture.scroll(1987);
    fixture.rerender({ loading: true, viewportRevision: 1 });
    fixture.layout();
    expect(fixture.grid.scrollTop).toBe(1987);
    fixture.rerender({ rows: fixture.page(100, 'g2'), loading: false });
    fixture.layout();
    fixture.selectionEffect();
    expect(fixture.grid.scrollTop).toBe(0);
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('0');
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
  });

  it('retains a Follow-off anchor through a temporary loading page and restores fractional position on resize', () => {
    const fixture = manualTailFixture({ followMode: false, latestSeq: '126' });
    fixture.rerender({ rows: fixture.page(100, 'g1', 26) });
    Object.assign(fixture.grid, { clientHeight: 773 });
    fixture.layout();
    fixture.wheel(-1);
    fixture.scroll(2196.8);
    fixture.rerender({ rows: [], loading: true });
    fixture.layout();
    fixture.rerender({ rows: fixture.page(46, 'g2', 81), loading: false, latestSeq: '127', latestGeneration: 'g2' });
    fixture.grid.scrollTop = 636.8;
    fixture.layout();
    expect(fixture.grid.scrollTop).toBeCloseTo(546.8, 8);
    Object.assign(fixture.grid, { clientHeight: 950 });
    fixture.grid.scrollTop = 460;
    fixture.resize();
    expect(fixture.grid.scrollTop).toBe(460);
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('96');
    Object.assign(fixture.grid, { clientHeight: 773 });
    fixture.resize();
    expect(fixture.grid.scrollTop).toBeCloseTo(546.8, 8);
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('99');
  });

  it('reveals an initial Follow-off selection after layout when the first loaded page has no historical anchor', () => {
    const fixture = manualTailFixture({ rows: [], followMode: false, selectedOrdinal: '87', latestSeq: '100' });
    fixture.layout();
    fixture.selectionEffect();
    fixture.rerender({ rows: fixture.page(100) });
    fixture.layout();
    fixture.selectionEffect();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(87, { align: 'auto' });
  });

  it('reveals the same Follow-off ordinal in a new session after layout rather than preserving the old session viewport', () => {
    const fixture = manualTailFixture({ followMode: false, selectedOrdinal: '87', latestSeq: '100' });
    fixture.rerender({ rows: fixture.page(100) });
    fixture.layout();
    fixture.selectionEffect();
    fixture.wheel(-1);
    fixture.scroll(1507);
    virtualizer.scrollToIndex.mockClear();
    fixture.rerender({ sessionId: 'another-synthetic-document', rows: fixture.page(100, 'g2') });
    fixture.layout();
    fixture.selectionEffect();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(87, { align: 'auto' });
  });

  it('reveals a Follow-off selection again after it was cleared following viewport restoration', () => {
    const fixture = manualTailFixture({ followMode: false, selectedOrdinal: '105', latestSeq: '126' });
    fixture.rerender({ rows: fixture.page(100, 'g1', 26) });
    Object.assign(fixture.grid, { clientHeight: 773 });
    fixture.layout();
    fixture.selectionEffect();
    fixture.wheel(-1);
    fixture.scroll(2196.8);
    fixture.rerender({ rows: fixture.page(46, 'g2', 81) });
    fixture.layout();
    fixture.selectionEffect();
    virtualizer.scrollToIndex.mockClear();
    fixture.rerender({ selectedOrdinal: undefined });
    fixture.layout();
    fixture.selectionEffect();
    fixture.rerender({ selectedOrdinal: '105' });
    fixture.layout();
    fixture.selectionEffect();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(24, { align: 'auto' });
  });

  it('retains the desired Follow-off anchor after a delayed native clamp scroll so a smaller viewport can restore it', () => {
    const fixture = manualTailFixture({ followMode: false, latestSeq: '126' });
    fixture.rerender({ rows: fixture.page(100, 'g1', 26) });
    Object.assign(fixture.grid, { clientHeight: 773 });
    fixture.layout();
    fixture.wheel(-1);
    fixture.scroll(2196.8);
    fixture.rerender({ rows: fixture.page(30, 'g2', 81) });
    // The browser has already reached the bounded target before layout.
    fixture.grid.scrollTop = 157;
    virtualizer.scrollToOffset.mockClear();
    fixture.layout();
    expect(virtualizer.scrollToOffset).not.toHaveBeenCalled();
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0].ordinal).toBe('86');
    fixture.scroll(157);
    Object.assign(fixture.grid, { clientHeight: 300 });
    fixture.resize();
    expect(fixture.grid.scrollTop).toBeCloseTo(546.8, 8);
    expect(fixture.onViewportAnchor.mock.calls.at(-1)?.[0]).toMatchObject({ ordinal: '99', generation: 'g2' });
    expect(fixture.onManualTailVisible).not.toHaveBeenCalled();
    expect(fixture.onTailVisible).not.toHaveBeenCalled();
  });

  it('moves control End across the page without activating a record', () => {
    const { press, onSelect } = render({ selectedOrdinal: '1' });
    press('End', true);
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(1, { align: 'auto' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['grid background', 'row gutter', 'virtual row gap'])(
    'keeps selection and scroll position when pointer focus comes from the %s', (location) => {
      const { element, onSelect } = render({ selectedOrdinal: undefined });
      const grid = { contains: () => false } as unknown as HTMLDivElement;
      const target = location === 'grid background' ? grid
        : { className: location === 'row gutter' ? 'data-grid-row' : 'virtual-space' };
      element.props.onPointerDownCapture?.({ currentTarget: grid, target } as unknown as React.PointerEvent<HTMLDivElement>);
      element.props.onFocus?.({ currentTarget: grid, target: grid, relatedTarget: null } as React.FocusEvent<HTMLDivElement>);
      expect(onSelect).not.toHaveBeenCalled();
      expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    },
  );

  it.each(['onPointerUpCapture', 'onPointerCancelCapture', 'onPointerLeave'] as const)(
    'allows keyboard entry after a pointer sequence ends via %s without focusing the grid', (endEvent) => {
      const { element, onSelect } = render({ selectedOrdinal: '1' });
      const grid = { contains: () => false } as unknown as HTMLDivElement;
      element.props.onPointerDownCapture?.({ currentTarget: grid, target: grid } as unknown as React.PointerEvent<HTMLDivElement>);
      const event = { currentTarget: grid, target: grid } as unknown as React.PointerEvent<HTMLDivElement>;
      element.props[endEvent]?.(event);
      element.props.onFocus?.({ currentTarget: grid, target: grid, relatedTarget: null } as React.FocusEvent<HTMLDivElement>);
      expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: 'auto' });
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it('consumes pointer entry so the next keyboard entry still reveals the selected row', () => {
    const { element } = render({ selectedOrdinal: '1' });
    const grid = { contains: () => false } as unknown as HTMLDivElement;
    element.props.onPointerDownCapture?.({ currentTarget: grid, target: grid } as unknown as React.PointerEvent<HTMLDivElement>);
    const event = { currentTarget: grid, target: grid, relatedTarget: null } as React.FocusEvent<HTMLDivElement>;
    element.props.onFocus?.(event);
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    element.props.onFocus?.(event);
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: 'auto' });
  });

  it('restores the active cell when keyboard focus re-enters instead of resetting to the selected row', () => {
    gridState.cell = { kind: 'data', sessionId: 'synthetic-document', generation: 'g1', ordinal: '1', columnId: 'status' };
    const { element, onSelect } = render({ selectedOrdinal: '0' });
    const grid = { contains: () => false } as unknown as HTMLDivElement;
    element.props.onFocus?.({ currentTarget: grid, target: grid, relatedTarget: null } as React.FocusEvent<HTMLDivElement>);
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: 'auto' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('enters at the selected row for keyboard focus when there is no active cell', () => {
    const { element, onSelect } = render({ selectedOrdinal: '1' });
    const grid = { contains: () => false } as unknown as HTMLDivElement;
    element.props.onFocus?.({ currentTarget: grid, target: grid, relatedTarget: null } as React.FocusEvent<HTMLDivElement>);
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: 'auto' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('focuses the clicked cell before revealing a record so a valid click cannot scroll to the first row', () => {
    const { element, onSelect, rows } = render({ selectedOrdinal: undefined });
    type GridElement = React.ReactElement<React.HTMLAttributes<HTMLDivElement> & {
      ref: { current: HTMLDivElement | null };
      children: GridElement[];
    }>;
    const root = element as GridElement;
    const grid = {
      contains: () => false,
      focus: () => root.props.onFocus?.({ currentTarget: grid, target: grid, relatedTarget: null } as unknown as React.FocusEvent<HTMLDivElement>),
    } as unknown as HTMLDivElement;
    root.props.ref.current = grid;
    const virtualSpace = root.props.children[1]!;
    const secondRow = virtualSpace.props.children[1]!;
    const secondCell = secondRow.props.children[1]!;
    secondCell.props.onClick?.({} as React.MouseEvent<HTMLDivElement>);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(rows[1]!.ref);
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: 'auto' });
  });

  it('opens a record only on explicit Enter or Space, while arrows move focus', () => {
    const { press, onSelect } = render();
    press('Enter');
    press('ArrowUp');
    press('ArrowDown');
    expect(virtualizer.scrollToIndex.mock.calls.map(([index]) => index)).toEqual([0, 0]);
    expect(onSelect).toHaveBeenCalledOnce();
    render().press(' ');
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
  });

  it('does not navigate while a replacement page is loading', () => {
    const { press, onSelect } = render({ loading: true });
    press('Home');
    press('End');
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys and empty pages', () => {
    render().press('Tab');
    render({ rows: [] }).press('Home');
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
  });

  it('announces header-inclusive row indexes and one grid Tab stop', () => {
    const { element } = render();
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain('aria-rowcount="3" aria-colcount="2"');
    expect(markup).toContain('role="row" aria-rowindex="1"');
    expect(markup).toContain('role="row" aria-rowindex="2"');
    expect(markup).toContain('role="row" aria-rowindex="3"');
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/role="separator" tabindex="-1" aria-orientation="vertical" aria-controls=/g)).toHaveLength(2);
    expect(markup).toContain('aria-valuetext="160 pixels wide"');
  });

  it('references only mounted cells and adds at most the active row to the virtual range', () => {
    gridState.cell = { kind: 'data', sessionId: 'synthetic-document', generation: 'g1', ordinal: '0', columnId: 'status' };
    const markup = renderToStaticMarkup(render().element);
    const id = gridCellId('synthetic-document', 'g1', '0', 'status');
    expect(markup).toContain(`aria-activedescendant="${id}"`);
    expect(markup).toContain(`id="${id}"`);
    const options = vi.mocked(useVirtualizer).mock.calls.at(-1)![0];
    expect(options.rangeExtractor?.({ startIndex: 1, endIndex: 1, overscan: 0, count: 2 })).toEqual([0, 1]);
    gridState.items = [];
    expect(renderToStaticMarkup(render().element)).not.toContain('aria-activedescendant=');
  });

  it('does not announce stale data focus after a page or generation replacement', () => {
    gridState.cell = { kind: 'data', sessionId: 'synthetic-document', generation: 'old', ordinal: '0', columnId: 'status' };
    expect(renderToStaticMarkup(render().element)).not.toContain('aria-activedescendant=');
  });

  it('enters the header separator explicitly and keeps resize keys separate from grid navigation', () => {
    gridState.cell = { kind: 'header', columnId: '__ordinal' };
    const onColumnWidthChange = vi.fn();
    const { element, press, onSelect } = render({ onColumnWidthChange, columnWidths: { __ordinal: 64 } });
    type ResizeProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { ref: (button: HTMLButtonElement) => void };
    type Heading = React.ReactElement<{ children: Array<React.ReactElement<ResizeProps>> }>;
    const [header] = element.props.children as React.ReactElement<{ children: Heading[] }>[];
    const resizer = header!.props.children[0]!.props.children.find((child) => child?.props.className === 'column-resizer')!;
    const focus = vi.fn();
    resizer.props.ref({ focus } as unknown as HTMLButtonElement);
    press('Enter');
    expect(focus).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    const resize = (key: string): void => resizer.props.onKeyDown?.({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.KeyboardEvent<HTMLButtonElement>);
    resize('ArrowLeft');
    resize('ArrowRight');
    resize('Home');
    resize('ArrowDown');
    expect(onColumnWidthChange.mock.calls).toEqual([['__ordinal', 64], ['__ordinal', 80]]);
  });
});
