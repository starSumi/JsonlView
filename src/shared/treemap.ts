/** Bounded, metadata-only source tree for the Insights Treemap. */
export const TREEMAP_VERSION = 1 as const;
export const TREEMAP_MAX_NODES = 500;
/** Root is level 1, so at most 500 levels are accepted. */
export const TREEMAP_MAX_DEPTH = 500;
export const TREEMAP_MAX_ID_LENGTH = 256;
export const TREEMAP_MAX_LABEL_LENGTH = 256;
export const TREEMAP_MAX_FINGERPRINT_LENGTH = 512;
/** Bounds payload size and decimal parsing work independently of magnitude. */
export const TREEMAP_MAX_VALUE_DIGITS = 1024;

export type TreemapMetric = 'bytes' | 'records';
export type TreemapScope = 'source' | 'provider' | 'session' | 'event-kind' | 'field-group';

export interface TreemapNodeV1 {
  id: string;
  label: string;
  /** Decimal, non-negative integer. Decimal strings preserve byte precision. */
  value: string;
  children?: TreemapNodeV1[];
}

export interface TreemapMetadataV1 {
  version: typeof TREEMAP_VERSION;
  sourceId: string;
  documentId: string;
  generation: string;
  fingerprint: string;
  metric: TreemapMetric;
  scope: TreemapScope;
  root: TreemapNodeV1;
  truncated: boolean;
}

export interface TreemapIdentity {
  sourceId: string;
  documentId: string;
  generation: string;
  fingerprint: string;
}
