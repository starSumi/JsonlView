import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InsightSummary } from '../../src/shared/types';
import { formatInsightProvenance, InsightsToolbar } from '../../src/webview/insights-toolbar';

const result: InsightSummary = {
  intent: { version: 1, intentRevision: 1, dimension: 'eventKind', scope: 'whole-file',
    document: { documentId: 'doc', generation: 'g1' }, profile: { id: 'generic', version: '1' } },
  provenance: { scope: 'whole-file', predicateApplied: false, coverage: 'bounded' },
  categories: [], timeBuckets: [], processedRecords: '3', examinedRecords: '100', examinedBytes: '1024',
  truncated: true, truncatedReason: 'record_limit', capacityReached: false, bucketWidthMs: 300_000,
};

describe('Insights scope controls and provenance', () => {
  it('names both scopes and keeps scope editable during a pending analysis', () => {
    const markup = renderToStaticMarkup(React.createElement(InsightsToolbar, {
      dimension: 'eventKind', scope: 'current-view', pending: true, disabled: false, result,
      onDimensionChange: () => {}, onScopeChange: () => {}, onRefresh: () => {},
    }));
    expect(markup).toContain('<span>Scope</span>');
    expect(markup).toContain('<option value="current-view" selected="">Current view</option>');
    expect(markup).toContain('<option value="whole-file">Whole file</option>');
    expect(markup).not.toContain('<select disabled');
    expect(markup).toContain('Whole file · bounded sample · 100 examined · 3 matched · record limit');
    expect(markup).not.toContain('complete scan');
  });

  it('distinguishes a completed scan from bounded evidence and grouped overflow', () => {
    expect(formatInsightProvenance(result)).toBe(
      'Whole file · bounded sample · 100 examined · 3 matched · record limit',
    );
    const { truncatedReason: _reason, ...complete } = result;
    expect(formatInsightProvenance({ ...complete, truncated: false,
      provenance: { ...result.provenance, scope: 'current-view', coverage: 'complete' },
      capacityReached: true,
    })).toBe('Current view · complete scan · 100 examined · 3 matched · grouped overflow');
  });
});
