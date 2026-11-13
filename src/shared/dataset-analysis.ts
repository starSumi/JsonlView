import type { FieldPath } from './contracts/record';
import { DATASET_ANALYSIS_LIMITS } from './contracts/dataset-summary';
import type { DatasetIssue, DatasetRecordSummary, DatasetRole, DatasetScene, DatasetTargetState, DatasetTokenSequence } from './contracts/dataset-summary';

export { DATASET_ANALYSIS_LIMITS } from './contracts/dataset-summary';
export type { DatasetIssue, DatasetRecordSummary, DatasetRole, DatasetScene, DatasetTargetState, DatasetTokenSequence } from './contracts/dataset-summary';

export interface DatasetNumericSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
}

export interface DatasetSampleSummary {
  version: 1;
  scope: 'visible-page' | 'observed-sample';
  coverage: { requestedRecords: number; sampledRecords: number; validRecords: number; invalidRecords: number; partial: boolean };
  scenes: Partial<Record<DatasetScene, number>>;
  targets: Partial<Record<DatasetTargetState, number>>;
  issues: Partial<Record<DatasetIssue, number>>;
  messages: DatasetRecordSummary['messages'];
  media: DatasetRecordSummary['media'];
  categories: Array<{ field: DatasetRecordSummary['categories'][number]['field']; values: Array<{ value: string; count: number }>; otherObservations: number }>;
  /** Kept separate by source field: declared counts are never measured lengths. */
  tokenLengths: Array<{ field: DatasetTokenSequence['field']; statistics: DatasetNumericSummary }>;
  declaredTokenCounts: Array<{ field: 'token_count' | 'num_tokens'; statistics: DatasetNumericSummary }>;
}
