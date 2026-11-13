import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopQueryStudio, type TopQueryStudioProps } from '../../src/webview/features/record-query/TopQueryStudio';
import { RecordQueryControls, type RecordQueryControlsProps } from '../../src/webview/features/record-query/RecordQueryControls';

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: <Value,>(current: Value): { current: Value } => ({ current }),
}));
vi.mock('../../src/webview/features/record-query/use-query-studio-light-dismiss', () => ({ useQueryStudioLightDismiss: vi.fn() }));
vi.mock('../../src/webview/features/record-query/use-native-popover-anchor', () => ({ useNativePopoverAnchor: () => ({ style: {} }) }));

function find<Props>(node: React.ReactNode, type: React.ElementType): React.ReactElement<Props> {
  const visit = (candidate: React.ReactNode): React.ReactElement<Props> | undefined => {
    for (const element of React.Children.toArray(candidate)) {
      if (!React.isValidElement<{ children?: React.ReactNode }>(element)) continue;
      if (element.type === type) return element as React.ReactElement<Props>;
      const child = visit(element.props.children);
      if (child !== undefined) return child;
    }
    return undefined;
  };
  const element = visit(node);
  if (element === undefined) throw new Error('Expected Studio child');
  return element;
}

function studio(overrides: Partial<TopQueryStudioProps> = {}) {
  const props: TopQueryStudioProps = {
    open: true, pinned: true, size: { width: 640, height: 430 }, maximized: false,
    queryControls: {
      query: '', searchDisabled: false, sortDirection: 'asc', descendingDisabled: false,
      descendingDisabledReason: '', onSortDirectionChange: vi.fn(), onSearchSubmit: vi.fn(),
      onSearchChange: vi.fn(), onSearchClear: vi.fn(), filterActive: false, filterableColumns: [],
      filterColumnId: '', filterOperator: 'contains', filterOperators: [], filterValue: '', filterCaseSensitive: false,
      onFilterColumnChange: vi.fn(), onFilterOperatorChange: vi.fn(), onFilterValueChange: vi.fn(),
      onFilterCaseSensitiveChange: vi.fn(), onFilterSubmit: vi.fn(), onFilterClear: vi.fn(),
    },
    history: [], pending: false, disabled: false, onToggle: vi.fn(), onTogglePin: vi.fn(), onSizeChange: vi.fn(),
    onToggleMaximize: vi.fn(), onClose: vi.fn(), onRun: vi.fn(), onCancel: vi.fn(), onHistorySelect: vi.fn(), ...overrides,
  };
  const element = TopQueryStudio(props);
  const panel = find<React.HTMLAttributes<HTMLElement>>(element, 'section');
  const press = (key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean } = {}) => {
    const currentTarget = { contains: () => true };
    vi.stubGlobal('HTMLElement', Object);
    const event = { key, ctrlKey: false, metaKey: false, currentTarget, target: currentTarget,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), ...modifiers,
      nativeEvent: { isComposing: modifiers.isComposing ?? false } };
    panel.props.onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLElement>);
    return event;
  };
  const controls = find<RecordQueryControlsProps>(element, RecordQueryControls).props;
  return { props, press, controls };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Query Studio action wiring', () => {
  it('runs from both modified Enter shortcuts and native search submission', () => {
    const { props, press, controls } = studio();
    press('Enter', { ctrlKey: true });
    press('Enter', { metaKey: true });
    controls.onSearchSubmit();
    expect(props.onRun).toHaveBeenCalledTimes(3);
    expect(props.queryControls.onSearchSubmit).not.toHaveBeenCalled();
  });

  it.each([{ pending: true }, { disabled: true }])('blocks form submission and consumes modified Enter while %j', (state) => {
    const { props, press, controls } = studio(state);
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      const event = press('Enter', modifiers);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    }
    controls.onSearchSubmit();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.queryControls.onSearchSubmit).not.toHaveBeenCalled();
  });

  it('cancels pending work with Escape and closes only the idle branch', () => {
    const pending = studio({ pending: true, disabled: true });
    pending.press('Escape');
    expect(pending.props.onCancel).toHaveBeenCalledOnce();
    expect(pending.props.onClose).not.toHaveBeenCalled();
    const idle = studio();
    idle.press('Escape');
    expect(idle.props.onClose).toHaveBeenCalledOnce();
    expect(idle.props.onCancel).not.toHaveBeenCalled();
  });

  it('leaves IME modified Enter and Escape to composition', () => {
    const { props, press } = studio();
    const enter = press('Enter', { ctrlKey: true, isComposing: true });
    const escapeEvent = press('Escape', { isComposing: true });
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(escapeEvent.preventDefault).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
