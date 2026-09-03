import type { JsonScalar } from '../shared/types';

export const AGGREGATION_LIMITS = {
  defaultMaxRecords: 100_000,
  hardMaxRecords: 1_000_000,
  defaultMaxGroups: 32,
  hardMaxGroups: 1_024,
  defaultMaxBuckets: 512,
  hardMaxBuckets: 4_096,
  defaultMaxKeyLength: 128,
  hardMaxKeyLength: 1_024,
} as const;

export type CommonDimension = 'severity' | 'eventKind' | 'service' | 'status';

export type FieldSelector =
  | { kind: 'common'; dimension: CommonDimension }
  | { kind: 'cell'; columnId: string }
  | { kind: 'profile'; field: string }
  | { kind: 'derived'; field: string };

export interface AggregationLimits {
  maxRecords?: number;
  maxKeyLength?: number;
}

export interface CategoricalAggregationOptions extends AggregationLimits {
  selector: FieldSelector;
  maxGroups?: number;
  signal?: AbortSignal;
}

export interface TimeBucketAggregationOptions extends AggregationLimits {
  selector?: FieldSelector;
  bucketWidthMs: number;
  timestampUnit?: TimestampUnit;
  maxBuckets?: number;
  signal?: AbortSignal;
}

export type TimestampUnit = 'auto' | 'iso' | 's' | 'ms' | 'us' | 'ns';

export type AggregateGroupKind = 'value' | 'other' | 'unknown' | 'missing';

export interface CategoricalGroup {
  id: string;
  label: string;
  kind: AggregateGroupKind;
  count: number;
  value?: JsonScalar;
}

export interface TimeBucket {
  id: string;
  kind: 'time' | 'overflow' | 'unknown' | 'missing';
  label: string;
  count: number;
  startMs?: number;
  endExclusiveMs?: number;
}

export interface AggregationMeta {
  processedRecords: number;
  truncatedByRecordLimit: boolean;
  capacityReached: boolean;
  maxRecords: number;
  resultCapacity: number;
  retainedValueCapacity: number;
  strategy: 'first-seen-exact-until-cap';
  selectionIsOrderDependent: true;
  countGuarantee: 'retained and reserved bucket counts are exact; identities merged into Other or Overflow are not retained';
}

export interface CategoricalAggregationResult {
  kind: 'categorical';
  selector: FieldSelector;
  groups: CategoricalGroup[];
  meta: AggregationMeta;
}

export interface TimeBucketAggregationResult {
  kind: 'time-buckets';
  selector: FieldSelector;
  bucketWidthMs: number;
  timestampUnit: TimestampUnit;
  buckets: TimeBucket[];
  meta: AggregationMeta;
}

export type SelectedValue =
  | { state: 'value'; value: JsonScalar }
  | { state: 'missing' }
  | { state: 'unknown' };
