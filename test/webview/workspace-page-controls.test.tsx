import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePageControls, type WorkspacePageControlsProps } from '../../src/webview/features/workspace/WorkspacePageControls';

function render(overrides: Partial<WorkspacePageControlsProps> = {}): string {
  return renderToStaticMarkup(React.createElement(WorkspacePageControls, {
    visible: true,
    busy: false,
    invalidated: false,
    hasBefore: true,
    canAdvance: true,
    pageInput: '2',
    pageRange: 'Rows #101-#200',
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onJump: vi.fn(),
    onInputFocus: vi.fn(),
    onInputChange: vi.fn(),
    onInputKeyDown: vi.fn(),
    onInputBlur: vi.fn(),
    ...overrides,
  }));
}

describe('workspace page controls seam', () => {
  it('renders the existing pager contract without owning paging state', () => {
    const markup = render();

    expect(markup).toContain('class="page-controls"');
    expect(markup).toContain('aria-label="Page number"');
    expect(markup).toContain('Rows #101-#200');
    expect(markup).toContain('title="Previous page"');
    expect(markup).toContain('title="Next page"');
  });

  it('keeps hidden page controls unmounted when the workspace projection says so', () => {
    expect(render({ visible: false })).toBe('');
  });
});
