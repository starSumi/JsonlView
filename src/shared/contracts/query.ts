import type { FieldPath, JsonKind, JsonScalar } from './record';

export type CompareOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export type RowFilterOperator = CompareOperator | 'contains' | 'starts_with' | 'ends_with' | 'exists' | 'is_null' | 'kind_is';
export interface RowFilter {
  columnId: string;
  operator: RowFilterOperator;
  value?: JsonScalar;
  caseSensitive?: boolean;
  kind?: JsonKind;
  source?: 'record' | 'profile';
  path?: FieldPath;
}
export type Predicate =
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | { op: 'compare'; path: FieldPath; cmp: CompareOperator; value: JsonScalar }
  | { op: 'contains' | 'starts_with' | 'ends_with'; path: FieldPath; value: string; caseSensitive: boolean }
  | { op: 'exists' | 'is_null'; path: FieldPath }
  | { op: 'kind_is'; path: FieldPath; kind: JsonKind }
  | { op: 'text_search'; value: string; caseSensitive: boolean; paths?: FieldPath[] }
  | { op: 'profile_field'; field: string; cmp: CompareOperator; value: JsonScalar }
  | { op: 'profile_text'; field: string; cmp: 'contains' | 'starts_with' | 'ends_with'; value: string; caseSensitive: boolean }
  | { op: 'profile_exists' | 'profile_is_null'; field: string };

export interface RowProjectionPlan { conversation: boolean; dataset: boolean }
/** Pure wire-shape guard for the optional row projection plan. */
export function isRowProjectionPlan(value: unknown): value is RowProjectionPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return Object.keys(plan).length === 2
    && typeof plan.conversation === 'boolean'
    && typeof plan.dataset === 'boolean';
}

export interface RowScanBudget { maxExaminedRecords?: number; maxExaminedBytes?: string | bigint; deadlineEpochMs?: number }
export type ScanTruncationReason = 'record_limit' | 'byte_limit' | 'time_limit' | 'hydration_limit' | 'uninspectable_record';
export type SortDirection = 'asc' | 'desc';
export interface RowSort { columnId: string; direction: SortDirection }

export type InsightDimension = 'eventKind' | 'severity' | 'service' | 'status';
export type InsightScope = 'current-view' | 'whole-file';
export interface AnalysisIntentV1 {
  version: 1;
  intentRevision: number;
  dimension: InsightDimension;
  scope: InsightScope;
  document: { documentId: string; generation: string; sourceEpoch?: number };
  profile: { id: string; version: string };
  predicate?: Predicate;
}
export interface InsightProvenance { scope: InsightScope; predicateApplied: boolean; coverage: 'complete' | 'bounded' }
export interface InsightCategory { label: string; count: number; approximate?: boolean }
export interface InsightTimeBucket { start: string; count: number }
export interface InsightSummary {
  intent: AnalysisIntentV1;
  provenance: InsightProvenance;
  categories: InsightCategory[];
  timeBuckets: InsightTimeBucket[];
  processedRecords: string;
  examinedRecords: string;
  examinedBytes: string;
  truncated: boolean;
  truncatedReason?: ScanTruncationReason;
  capacityReached: boolean;
  bucketWidthMs: number;
}
