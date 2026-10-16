import type { FieldPath } from './types';

/** Bounded observations without body text; never trainer configuration or tokenizer output. */
export type DatasetScene = 'pretraining' | 'instruction' | 'qa' | 'preference' | 'conversation' | 'classification' | 'tokenized' | 'unknown';
export type DatasetTargetState = 'present' | 'empty' | 'missing' | 'not-applicable' | 'unknown';
export type DatasetRole = 'user' | 'assistant' | 'system' | 'tool' | 'function' | 'unknown';
export type DatasetIssue = 'invalid-record' | 'unknown-scene' | 'missing-target' | 'empty-target' | 'incomplete-preference' | 'invalid-message' | 'unknown-role' | 'invalid-loss-weight' | 'invalid-token-id' | 'invalid-declared-count' | 'token-count-mismatch' | 'token-length-mismatch' | 'inspection-truncated';

export interface DatasetTokenSequence {
  path: FieldPath;
  field: 'tokens' | 'input_ids' | 'labels' | 'attention_mask';
  /** Actual array length, not a computed tokenizer token count. */
  length: number;
  inspected: number;
  nonInteger: number;
  /** Literal occurrences only; no training mask semantics are assumed. */
  negative100: number;
  truncated: boolean;
}

export interface DatasetRecordSummary {
  version: 1;
  valid: boolean;
  scene: DatasetScene;
  target: DatasetTargetState;
  evidence: FieldPath[];
  messages: {
    total: number;
    observed: number;
    roles: Record<DatasetRole, number>;
    lossWeights: { specified: number; zero: number; positive: number; negative: number; invalid: number; array: number };
    truncated: boolean;
  };
  tokens: {
    sequences: DatasetTokenSequence[];
    declared: Array<{ path: FieldPath; field: 'token_count' | 'num_tokens'; value: number }>;
    mismatch: boolean;
  };
  /** Counts observed references only. References are never opened or fetched. */
  media: { image: number; audio: number; video: number };
  categories: Array<{ field: 'label' | 'category' | 'split' | 'language'; value: string }>;
  issues: DatasetIssue[];
  truncated: boolean;
}

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
