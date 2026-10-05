import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecordQueryBanner, buildRecordQueryBannerIdentity } from '../../src/webview/features/record-query/RecordQueryBanner';

const hydrationScan = {
  examinedRecords: '62',
  examinedBytes: '8388608',
  cursorOrdinal: '43018',
  direction: 'backward' as const,
  truncatedReason: 'hydration_limit' as const,
};

describe('record query partial-result banner', () => {
  it('does not render without a truncated scan', () => {
    expect(renderToStaticMarkup(React.createElement(RecordQueryBanner))).toBe('');
  });

  it('explains that a physical descending page is exact but hydration-bounded', () => {
    const markup = renderToStaticMarkup(React.createElement(RecordQueryBanner, {
      scan: hydrationScan,
      sort: { columnId: '__ordinal', direction: 'desc' },
      pageIdentity: 'page-1',
    }));
    expect(markup).toContain('Page contains 62 records because the page hydration budget was reached.');
    expect(markup).toContain('The physical order remains exact');
    expect(markup).toContain('aria-label="Dismiss partial-result notice"');
    expect(markup).toContain('title="Dismiss partial-result notice"');
    expect(markup).not.toContain('This physical reverse page is partial');
  });

  it('keeps the sorted-window warning for field sorts', () => {
    const markup = renderToStaticMarkup(React.createElement(RecordQueryBanner, {
      scan: { ...hydrationScan, examinedRecords: '7' },
      sort: { columnId: 'timestamp', direction: 'asc' },
      pageIdentity: 'page-2',
    }));
    expect(markup).toContain('This sorted order is partial');
    expect(markup).toContain('visible order is guaranteed only within the retained sorted window');
  });

  it('changes the dismissal identity when the page changes', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    expect(buildRecordQueryBannerIdentity(hydrationScan, sort, 'page-1'))
      .not.toBe(buildRecordQueryBannerIdentity(hydrationScan, sort, 'page-2'));
  });
});
