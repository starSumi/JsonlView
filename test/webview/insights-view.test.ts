import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InsightsView } from '../../src/webview/insights-view';

function render(props: Partial<React.ComponentProps<typeof InsightsView>> = {}): string {
  return renderToStaticMarkup(React.createElement(InsightsView, {
    categories: [],
    timeBuckets: [],
    loading: false,
    ...props,
  }));
}

describe('InsightsView', () => {
  it('renders stable loading, cancellation, error, and empty states', () => {
    expect(render({ loading: true })).toContain('aria-busy="true"');
    expect(render({ loading: true })).toContain('Loading aggregates');
    expect(render({ cancelled: true, loading: true })).toContain('data-kind="cancelled"');
    expect(render({ error: 'Aggregation failed' })).toContain('role="alert"');
    expect(render({ error: 'Aggregation failed' })).toContain('Aggregation failed');
    expect(render()).toContain('No aggregate data for the current query');
  });

  it('renders accessible charts and exact tabular readouts', () => {
    const markup = render({
      categories: [
        { label: 'tool_call', count: 12 },
        { label: 'message', count: 7, approximate: true },
      ],
      timeBuckets: [
        { start: '2026-08-30T10:00:00Z', count: 4 },
        { start: '2026-08-30T11:00:00Z', count: 9 },
      ],
    });

    expect(markup.match(/role="img"/g)).toHaveLength(2);
    expect(markup).toContain('<caption>Category aggregate values</caption>');
    expect(markup).toContain('<caption>Time bucket aggregate values</caption>');
    expect(markup).toContain('aria-label="approximately 7"');
    expect(markup).toContain('2026-08-30 10:00:00Z');
    expect(markup).toContain('2 buckets · 13 records');
  });

  it('bounds chart and table output for unexpectedly large aggregate responses', () => {
    const categories = Array.from({ length: 80 }, (_, index) => ({
      label: `category-${String(index)}`,
      count: index,
    }));
    const markup = render({ categories });

    expect(markup.match(/class="insights-chart-bar"/g)).toHaveLength(64);
    expect(markup).toContain('Showing 64 of 80 categories');
    expect(markup).not.toContain('category-79</th>');
  });
});
