import { describe, expect, it } from 'vitest';
import { summarizeDatasetRecord } from '../../src/profiles/dataset-analysis';
import type { RowProjection } from '../../src/shared/types';
import { summarizeVisibleDatasetRows } from '../../src/webview/dataset-page-analysis';

const row = (value: unknown): RowProjection => ({ dataset: summarizeDatasetRecord(value) } as RowProjection);
describe('current page dataset observations', () => {
  it('does not present dataset analysis for agent-only or unrecognized rows', () => {
    expect(summarizeVisibleDatasetRows([{ cells: [] } as unknown as RowProjection])).toBeUndefined();
    expect(summarizeVisibleDatasetRows([row({ arbitrary: 5 })])).toBeUndefined();
  });

  it('reports loaded scope and missing observations without borrowing other pages', () => {
    const first = summarizeVisibleDatasetRows([row({ question: 'q', answer: 'a' }), { cells: [] } as unknown as RowProjection]);
    expect(first).toMatchObject({ scope: 'visible-page', scenes: { qa: 1 }, coverage: { requestedRecords: 2, sampledRecords: 1, partial: true } });
    const second = summarizeVisibleDatasetRows([row({ text: 'Training text' })], true);
    expect(second?.scenes).toEqual({ pretraining: 1 });
    expect(second?.coverage.partial).toBe(true);
  });

  it('inspects at most 256 rows while retaining the requested page size', () => {
    const rows = Array.from({ length: 300 }, () => row({ text: 'Sample' }));
    Object.defineProperty(rows[256], 'dataset', { get: () => { throw new Error('Outside inspection budget'); } });
    expect(summarizeVisibleDatasetRows(rows)?.coverage).toMatchObject({ requestedRecords: 300, sampledRecords: 256, partial: true });
  });
});
