import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  applyQueryStudioPreset,
  clampQueryStudioSize,
  QUERY_STUDIO_PRESETS,
  stepQueryStudioSize,
  TopQueryStudio,
  type TopQueryStudioProps,
} from '../../src/webview/features/record-query/TopQueryStudio';

function render(overrides: Partial<TopQueryStudioProps> = {}): string {
  const props: TopQueryStudioProps = {
    open: false,
    pinned: false,
    size: { width: 640, height: 430 },
    maximized: false,
    queryControls: {
      query: '', searchDisabled: false, sortDirection: 'asc', descendingDisabled: false,
      descendingDisabledReason: '', onSortDirectionChange: vi.fn(), onSearchSubmit: vi.fn(),
      onSearchChange: vi.fn(), onSearchClear: vi.fn(), filterActive: false, filterableColumns: [],
      filterColumnId: '', filterOperator: 'contains', filterOperators: [{ value: 'contains', label: 'Contains', needsValue: true }],
      filterValue: '', filterCaseSensitive: false, onFilterColumnChange: vi.fn(), onFilterOperatorChange: vi.fn(),
      onFilterValueChange: vi.fn(), onFilterCaseSensitiveChange: vi.fn(), onFilterSubmit: vi.fn(), onFilterClear: vi.fn(),
    },
    history: [], pending: false, disabled: false, onToggle: vi.fn(), onTogglePin: vi.fn(), onSizeChange: vi.fn(),
    onToggleMaximize: vi.fn(), onClose: vi.fn(), onRun: vi.fn(), onCancel: vi.fn(), onHistorySelect: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(TopQueryStudio, props));
}

describe('Top Query Studio projection', () => {
  it('keeps the closed state free of studio controls', () => {
    const markup = render();
    expect(markup).toContain('data-query-studio-toggle');
    expect(markup).not.toContain('data-query-studio=""');
  });

  it('shows an accessible Keep open pin control that does not claim fixed positioning', () => {
    const markup = render({ open: true, pinned: false });
    expect(markup).toContain('Keep open');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('position is not locked');
  });

  it('exposes the pressed state while pinned', () => {
    const markup = render({ open: true, pinned: true });
    expect(markup).toContain('aria-pressed="true"');
  });

  it('provides keyboard-focusable width and height controls with the prototype size readout', () => {
    const markup = render({ open: true });

    expect(markup).toContain('aria-label="Make Query Studio narrower"');
    expect(markup).toContain('aria-label="Make Query Studio wider"');
    expect(markup).toContain('aria-label="Make Query Studio shorter"');
    expect(markup).toContain('aria-label="Make Query Studio taller"');
    expect(markup).toContain('<fieldset class="query-studio-size-controls" aria-label="Query Studio size controls">');
    expect(markup).toContain('aria-label="Query Studio size 640 by 430 pixels"');
    expect(markup).toContain('640 × 430');
  });

  it('exposes maximize and restore as distinct accessible panel states', () => {
    expect(render({ open: true })).toContain('aria-label="Maximize Query Studio"');
    expect(render({ open: true, maximized: true })).toContain('aria-label="Restore Query Studio"');
  });

  it('marks only the maximized dialog as modal for focus containment', () => {
    expect(render({ open: true })).not.toContain('aria-modal="true"');
    expect(render({ open: true, maximized: true })).toContain('aria-modal="true"');
  });

  it('uses bounded 20-pixel keyboard steps without exceeding prototype controls', () => {
    expect(stepQueryStudioSize({ width: 640, height: 430 }, 'width', 1)).toEqual({ width: 660, height: 430 });
    expect(stepQueryStudioSize({ width: 480, height: 320 }, 'width', -1)).toEqual({ width: 480, height: 320 });
    expect(clampQueryStudioSize({ width: 1200, height: 200 })).toEqual({ width: 1100, height: 320 });
  });

  it('exposes a bounded expanded region with run, cancel and session history actions', () => {
    const markup = render({
      open: true,
      pending: true,
      history: [{ id: 'deadbeef', query: 'error', filters: [], label: 'error' }],
    });
    expect(markup).toContain('data-query-studio="true"');
    expect(markup).toContain('aria-label="Expanded query studio"');
    expect(markup).toContain('Run query');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('error');
  });

  it('marks the expanded studio as a manual native popover top-layer surface', () => {
    const markup = render({ open: true });

    expect(markup).toContain('popover="manual"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('data-query-studio="true"');
  });

  it('preloads bounded query templates without adding an execution side effect', () => {
    const onSearchChange = vi.fn();
    const onSearchSubmit = vi.fn();
    const preset = QUERY_STUDIO_PRESETS[0]!;

    applyQueryStudioPreset({ onSearchChange }, preset);

    expect(onSearchChange).toHaveBeenCalledWith(preset.query);
    expect(onSearchSubmit).not.toHaveBeenCalled();

    const markup = render({ open: true });
    expect(markup).toContain(`data-query-studio-preset="${preset.id}"`);
    expect(markup).toContain(preset.label);
  });
});
