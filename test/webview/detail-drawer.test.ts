import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecordDetail } from '../../src/shared/types';
import { DetailDrawer } from '../../src/webview/detail-drawer';

function detail(parseState: RecordDetail['ref']['parseState'], rawComplete: boolean): RecordDetail {
  return {
    ref: {
      generation: 'generation-1',
      ordinal: '7',
      byteStart: '0',
      byteEndExclusive: '24',
      contentByteLength: '23',
      delimiterByteLength: 1,
      parseState,
    },
    rawPreview: parseState === 'blank' ? '' : '{"incomplete":',
    rawComplete,
    problems: [{ code: parseState.toUpperCase(), message: `state: ${parseState}`, severity: 'warning' }],
  };
}

describe('detail drawer unavailable record states', () => {
  it('shows a selected unavailable record instead of a loading drawer', () => {
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      loading: false,
      blockedOrdinal: '302',
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('Record #302 unavailable');
    expect(markup).toContain('Select Rebuild');
    expect(markup).not.toContain('Loading record');
    expect(markup).not.toContain('aria-label="Detail views"');
    expect(markup).toContain('aria-label="Close detail"');
  });

  it('does not render a fake JSON tree when structured hydration is unavailable', () => {
    for (const parseState of ['oversized', 'invalid_json', 'blank', 'encoding_error'] as const) {
      const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
        detail: detail(parseState, parseState === 'invalid_json'),
        loading: false,
        activeTab: 'tree',
        onTabChange: () => undefined,
        onRequestFull: () => undefined,
        onClose: () => undefined,
      }));

      expect(markup).not.toContain('role="tree"');
      expect(markup).not.toContain('string">undefined');
      expect(markup).toContain('Structured view unavailable');
      expect(markup).toContain(`Parse state: ${parseState}`);
    }
  });

  it('explains how to hydrate a bounded oversized record', () => {
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: detail('oversized', false),
      loading: false,
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('jsonlView.hydration.maxBytes');
    expect(markup).toContain('Show full record');
    expect(markup).toContain('jsonlView.hydration.fullMaxBytes');
  });

  it('does not offer a stale full-record request after destructive invalidation', () => {
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: detail('oversized', false),
      loading: false,
      readBlocked: true,
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('select Rebuild before requesting the full record');
    expect(markup).not.toContain('Show full record');
    expect(markup).toContain('cached detail from generation generation-1');
    expect(markup).toContain('Copy cached snapshot preview (source changed)');
  });

  it('labels hydrated structured detail as an old snapshot while keeping it inspectable', () => {
    const cached = detail('valid', true);
    cached.value = { message: 'old content' };
    cached.problems = [];
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: cached,
      loading: false,
      readBlocked: true,
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('Source changed. Showing cached detail from generation generation-1');
    expect(markup).toContain('not the current file');
    expect(markup).toContain('Copy uses this old snapshot');
    expect(markup).toContain('Copy cached snapshot preview (source changed)');
    expect(markup).toContain('role="tree"');
  });

  it('keeps a legitimate null JSON value in the structured tree', () => {
    const value = detail('valid', true);
    value.value = null;
    value.problems = [];
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: value,
      loading: false,
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('role="tree"');
    expect(markup).toContain('json-token-null');
  });
});
