import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CategoryChart,
  formatBucketStart,
  formatCount,
  safeCount,
  TimeChart,
} from '../../src/webview/insights-chart';

describe('insights charts', () => {
  it('uses stable SVG dimensions and does not emit invalid geometry for bad counts', () => {
    const markup = renderToStaticMarkup(React.createElement(CategoryChart, {
      categories: [
        { label: 'negative', count: -3 },
        { label: 'infinite', count: Number.POSITIVE_INFINITY },
        { label: 'fraction', count: 2.9 },
      ],
    }));

    expect(markup).toContain('viewBox="0 0 640 200"');
    expect(markup).toContain('width="640" height="200"');
    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(safeCount(-3)).toBe(0);
    expect(safeCount(2.9)).toBe(2);
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('describes every time bar without depending on visible SVG text', () => {
    const markup = renderToStaticMarkup(React.createElement(TimeChart, {
      buckets: [
        { start: '2026-08-30T00:00:00Z', count: 3 },
        { start: 'not-a-date', count: 1 },
      ],
    }));

    expect(markup).toContain('<title>2026-08-30 00:00:00Z: 3</title>');
    expect(markup).toContain('<title>not-a-date: 1</title>');
    expect(formatBucketStart('not-a-date')).toBe('not-a-date');
  });
});
