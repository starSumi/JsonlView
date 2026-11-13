import { describe, expect, it } from 'vitest';
import { aggregateBfclV3Summaries, summarizeBfclV3Record } from '../../src/profiles/datasets/bfcl-v3';
import { workspaceBfclSummary } from '../../src/webview/features/workspace/projections';
import type { RowProjection } from '../../src/shared/types';

const row = (value: unknown): RowProjection => ({ datasetInsights: { bfclV3: summarizeBfclV3Record(value) } } as RowProjection);

describe('BFCL workspace projection', () => {
  it('selects BFCL summaries from the current physical page and preserves partial scope', () => {
    const value = { id: 'simple_1', multi_turn: false, functions: '[]', tools: '[]', missed_functions: '{}', initial_config: '{}', involved_classes: [], turns: '[]', language: 'Python', test_category: 'simple', subset: 'simple', ground_truth: '[]' };
    const summary = workspaceBfclSummary([row(value), {} as RowProjection], false);
    expect(summary).toEqual(aggregateBfclV3Summaries([summarizeBfclV3Record(value)], { partial: true, requestedRecords: 2 }));
    expect(summary?.coverage.requestedRecords).toBe(2);
    expect(summary?.coverage.partial).toBe(true);
  });
});
