import { aggregateDatasetSummaries, DATASET_ANALYSIS_LIMITS } from '@profiles/dataset-analysis';
import type { DatasetSampleSummary } from '@shared/dataset-analysis';
import type { RowProjection } from '@shared/types';

export function summarizeVisibleDatasetRows(rows: readonly RowProjection[], partial = false): DatasetSampleSummary | undefined {
  const inspected = rows.slice(0, DATASET_ANALYSIS_LIMITS.records);
  const samples = inspected.flatMap((row) => row.dataset === undefined ? [] : [row.dataset]);
  if (!samples.some((sample) => sample.scene !== 'unknown')) return undefined;
  const summary = aggregateDatasetSummaries(samples, {
    scope: 'visible-page',
    partial: partial || samples.length !== rows.length,
  });
  return { ...summary, coverage: { ...summary.coverage, requestedRecords: rows.length } };
}
