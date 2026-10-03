import type React from 'react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RowProjection } from '../../src/shared/types';
import { RecordTable, type RecordTableProps } from '../../src/webview/features/record-query/RecordTable';

const virtualizer = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  getTotalSize: () => 60,
  getVirtualItems: () => [],
}));

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: vi.fn(() => virtualizer) }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
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
    rows, columns: [], selectedOrdinal: '0', loading: false, onSelect,
    columnWidths: {}, onColumnWidthChange: vi.fn(),
    onColumnOrderChange: vi.fn(), ...overrides,
  }) as React.ReactElement<React.HTMLAttributes<HTMLDivElement>>;
  const press = (key: string): void => {
    element.props.onKeyDown?.({ key, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLDivElement>);
  };
  return { element, press, onSelect, rows };
}

describe('record table selection visibility', () => {
  beforeEach(() => vi.clearAllMocks());

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

  it('reveals the first row on Home even when it is already selected', () => {
    const { press, onSelect, rows } = render();
    press('Home');
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'auto' });
    expect(onSelect).toHaveBeenCalledWith(rows[0]!.ref);
  });

  it('reveals the last row on End even when it is already selected', () => {
    const { press, onSelect, rows } = render({ selectedOrdinal: '1' });
    press('End');
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(1, { align: 'auto' });
    expect(onSelect).toHaveBeenCalledWith(rows[1]!.ref);
  });

  it('reveals a repeated selection with Enter and clamps arrow keys', () => {
    const { press, onSelect } = render();
    press('Enter');
    press('ArrowUp');
    press('ArrowDown');
    expect(virtualizer.scrollToIndex.mock.calls.map(([index]) => index)).toEqual([0, 0, 1]);
    expect(onSelect).toHaveBeenCalledTimes(3);
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
});
