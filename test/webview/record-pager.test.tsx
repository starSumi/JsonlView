import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RecordPager, type RecordPagerProps } from '../../src/webview/features/record-query/RecordPager';

function render(overrides: Partial<RecordPagerProps> = {}): string {
  return renderToStaticMarkup(<RecordPager
    visible
    busy={false}
    invalidated={false}
    hasBefore
    canAdvance
    pageInput="2"
    pageRange="101-200"
    onPrevious={vi.fn()}
    onNext={vi.fn()}
    onJump={vi.fn()}
    onInputFocus={vi.fn()}
    onInputChange={vi.fn()}
    onInputKeyDown={vi.fn()}
    onInputBlur={vi.fn()}
    {...overrides}
  />);
}

describe('record pager states', () => {
  it('does not render when the page controls are hidden', () => {
    expect(renderToStaticMarkup(<RecordPager visible={false} busy={false} invalidated={false} hasBefore={false} canAdvance={false} pageInput="1" pageRange="" onPrevious={vi.fn()} onNext={vi.fn()} onJump={vi.fn()} onInputFocus={vi.fn()} onInputChange={vi.fn()} onInputKeyDown={vi.fn()} onInputBlur={vi.fn()} />)).toBe('');
  });

  it('renders the normal range and disabled invalidated state', () => {
    const markup = render({ invalidated: true, busy: true, hasBefore: false, canAdvance: false });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading page...');
    expect(markup).toContain('aria-label="Page number"');
    expect(markup).toContain('disabled=""');
  });

  it('exposes a ready page range and action labels', () => {
    const markup = render();
    expect(markup).toContain('101-200');
    expect(markup).toContain('Previous page');
    expect(markup).toContain('Next page');
  });
});
