import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecordDetail, RecordRef } from '../../src/shared/types';
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
  it('keeps the tree detail focused on the selected record without a secondary Navigator action', () => {
    const selected = detail('valid', true);
    selected.value = { message: 'keep current record visible' };
    selected.problems = [];
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: selected, loading: false, activeTab: 'tree',
      onTabChange: () => undefined, onRequestFull: () => undefined, onClose: () => undefined,
    }));

    expect(markup).not.toContain('aria-label="Open Navigator bridge"');
    expect(markup).not.toContain('打开 Navigator');
    expect(markup).toContain('aria-label="Bounded JSON tree"');
  });

  it('shows the selected record preview by default before its JSON fields', () => {
    const selected = detail('valid', true);
    selected.value = { type: 'session_meta', payload: {
      id: 'synthetic-session', model_provider: 'OpenAI',
      base_instructions: { text: '# Selected record preview\nSynthetic instructions for this record.' },
    } };
    selected.profile = { profileId: 'codex-rollout', eventKind: 'session', summary: 'Synthetic session',
      evidence: [], confidence: 'source' };
    selected.problems = [];
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: selected, loading: false, activeTab: 'tree',
      onTabChange: () => undefined, onRequestFull: () => undefined, onClose: () => undefined,
    }));
    const treeIndex = markup.indexOf('aria-label="Bounded JSON tree"');
    const semanticIndex = markup.indexOf('aria-label="Structured event view"');
    expect(treeIndex).toBeGreaterThan(-1);
    expect(semanticIndex).toBeGreaterThan(-1);
    expect(semanticIndex).toBeLessThan(treeIndex);
    expect(markup).toContain('class="event-presentation"');
    expect(markup).toContain('Codex · session meta');
    expect(markup).toContain('Base instructions');
    expect(markup).toContain('Selected record preview');
    for (const mode of ['Auto', 'Text', 'Markdown', 'JSON']) expect(markup).toContain(`>${mode}</button>`);
    expect(markup).not.toContain('Show semantic details');
  });

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
    expect(markup.match(/class="detail-content"/g)).toHaveLength(1);
    expect(markup).toContain('data-record-ref="generation-1:7:0:24:23:1"');
    expect(markup).not.toContain('detail-stream');
    expect(markup).not.toContain('data-detail-anchor-count');
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

  it('does not render a stale detail payload under a newer selected record', () => {
    const stale = detail('valid', true);
    stale.value = { event: 'old-detail' };
    stale.problems = [];
    const selectedRef: RecordRef = {
      ...stale.ref,
      ordinal: '8',
      byteStart: '24',
      byteEndExclusive: '48',
    };
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: stale,
      selectedRef,
      loading: false,
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('Record #8');
    expect(markup).toContain('Loading record');
    expect(markup).not.toContain('old-detail');
    expect(markup).not.toContain('role="tree"');
  });

  it('keeps the same physical cached record visible while its generation is rebased', () => {
    const cached = detail('valid', true);
    cached.value = { message: 'cached recovery content' };
    cached.problems = [];
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: cached,
      selectedRef: { ...cached.ref, generation: 'generation-2' },
      loading: true,
      readBlocked: true,
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('cached recovery content');
    expect(markup).toContain('Showing cached detail from generation generation-1');
    expect(markup).not.toContain('Loading record');
  });

  it('rejects cached content when a blocked selection has different byte coordinates', () => {
    const cached = detail('valid', true);
    cached.value = { message: 'wrong cached record' };
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: cached,
      selectedRef: { ...cached.ref, generation: 'generation-2', byteStart: '48', byteEndExclusive: '72' },
      loading: true,
      readBlocked: true,
      activeTab: 'tree',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('Loading record');
    expect(markup).not.toContain('wrong cached record');
    expect(markup).not.toContain('Showing cached detail');
  });

  it('does not trust an ordinal when generation and byte identity changed', () => {
    const stale = detail('valid', true);
    stale.value = { event: 'old-generation' };
    stale.problems = [];
    const rewrittenRef: RecordRef = {
      ...stale.ref,
      generation: 'generation-2',
      byteStart: '128',
      byteEndExclusive: '176',
    };
    const markup = renderToStaticMarkup(React.createElement(DetailDrawer, {
      detail: stale,
      selectedRef: rewrittenRef,
      loading: false,
      activeTab: 'raw',
      onTabChange: () => undefined,
      onRequestFull: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('Record #7');
    expect(markup).toContain('Loading record');
    expect(markup).not.toContain('old-generation');
    expect(markup).not.toContain('incomplete');
  });
});
