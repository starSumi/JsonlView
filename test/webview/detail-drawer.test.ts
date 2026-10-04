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
  it('connects manual detail tabs to mounted panels and one selected tab stop', () => {
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: detail('valid', true), loading: false, activeTab: 'raw',
      onTabChange: () => undefined, onRequestFull: () => undefined, onClose: () => undefined,
    }));
    expect(markup).toContain('role="tablist" aria-orientation="horizontal"');
    expect(markup.match(/role="tab"/g)).toHaveLength(4);
    expect(markup.match(/role="tabpanel"/g)).toHaveLength(4);
    expect(markup.match(/hidden=""/g)).toHaveLength(3);
    expect(markup).toMatch(/id="record-detail-views-tab-raw" aria-controls="record-detail-views-panel-raw" aria-selected="true" tabindex="0"/);
    expect(markup).toMatch(/role="tabpanel" id="record-detail-views-panel-raw" aria-labelledby="record-detail-views-tab-raw" tabindex="0"/);
  });

  it('uses labeled modal markup and a backdrop only for the narrow presentation', () => {
    const props = { loading: true, activeTab: 'tree' as const,
      onTabChange: () => undefined, onRequestFull: () => undefined, onClose: () => undefined };
    const narrow = renderToStaticMarkup(React.createElement(DetailDrawer, { ...props, id: 'synthetic-detail', modal: true }));
    expect(narrow).toContain('class="detail-backdrop" aria-hidden="true"');
    expect(narrow).toContain('role="dialog" aria-modal="true" aria-labelledby="synthetic-detail-title"');
    expect(narrow).toContain('id="synthetic-detail-title" class="detail-title" tabindex="-1"');
    const wide = renderToStaticMarkup(React.createElement(DetailDrawer, props));
    expect(wide).not.toContain('role="dialog"');
    expect(wide).not.toContain('aria-modal=');
    expect(wide).not.toContain('detail-backdrop');
  });

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
