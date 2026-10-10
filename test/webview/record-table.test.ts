import type React from 'react';
import { useEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RowProjection } from '../../src/shared/types';
import { RecordTable, type RecordTableProps } from '../../src/webview/features/record-query/RecordTable';
import { gridCellId, type GridCell } from '../../src/webview/use-grid-focus';

const gridState = vi.hoisted(() => ({
  cell: undefined as GridCell | undefined,
  items: [0, 1].map((index) => ({ index, key: index, start: 30 + index * 30, size: 30 })),
}));

const virtualizer = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
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
  useRef: <Value>(current: Value): { current: Value } => ({ current }),
}));

function render(overrides: Partial<RecordTableProps> = {}) {
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
    gridState.cell = undefined;
    gridState.items = [0, 1].map((index) => ({ index, key: index, start: 30 + index * 30, size: 30 }));
  });

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
    const previousDependencies = vi.mocked(useEffect).mock.calls.at(-1)![1];
    const nextRows = rows.map((row, index) => ({
      ...row, ref: { ...row.ref, ordinal: String(20 + index) },
    }));
    render({ rows: nextRows, selectedOrdinal: '20' });
    const [reveal, nextDependencies] = vi.mocked(useEffect).mock.calls.at(-1)!;
    expect(nextDependencies).not.toEqual(previousDependencies);
    expect(nextDependencies).toContain('20');
    reveal();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
  });

  it('reveals a replacement generation at the same ordinal and index', () => {
    const { rows } = render();
    const previousDependencies = vi.mocked(useEffect).mock.calls.at(-1)![1];
    const replacementRows = rows.map((row) => ({
      ...row, ref: { ...row.ref, generation: 'g2' },
    }));
    render({ rows: replacementRows });
    const [reveal, nextDependencies] = vi.mocked(useEffect).mock.calls.at(-1)!;
    expect(nextDependencies).not.toEqual(previousDependencies);
    expect(nextDependencies).toContain('g2');
    reveal();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
  });

  it('moves Home to the first column without activating a record', () => {
    const { press, onSelect } = render();
    press('Home');
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
    expect(onSelect).not.toHaveBeenCalled();
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
