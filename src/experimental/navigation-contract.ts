/**
 * Versioned, redacted records for the optional local agent navigator.
 *
 * These types intentionally carry projections and opaque identifiers only. A
 * provider owns its source format and must not pass paths, prompts, message
 * bodies, credentials, or source bytes through this contract by default.
 */

export const NAVIGATION_PROTOCOL_VERSION = 1 as const;

export type NavigationEntityKind =
  | 'source'
  | 'session'
  | 'thread'
  | 'turn'
  | 'workflow'
  | 'team'
  | 'tool'
  | 'goal'
  | 'plan'
  | 'memory'
  | 'task'
  | 'subagent'
  | 'event'
  | 'other';

export type NavigationRelationKind = 'parent' | 'child' | 'fork' | 'spawn' | 'contains' | 'uses';

/** Provenance for a title shown by the Session Navigator. */
export type NavigationTitleSource = 'product' | 'provider' | 'first-message' | 'id';

/** Stable relationship labels shared by provider adapters. */
export type NavigationRelationship = 'root' | 'subagent' | 'fork' | 'continuation' | 'orphan' | 'generic';

export interface NavigationEntity {
  sourceId: string;
  nativeId: string;
  kind: NavigationEntityKind;
  label: string;
  /** Provider-owned title, such as Codex thread metadata or Claude session name. */
  vendorTitle?: string;
  /** Product-owned title. It is stored in the JsonlView catalog only. */
  productTitle?: string;
  titleSource?: NavigationTitleSource;
  firstMessagePreview?: string;
  startedAt?: string;
  activityAt?: string;
  relationship?: NavigationRelationship;
  project?: string;
  parentNativeId?: string;
  updatedAt?: string;
  status?: string;
  confidence: 'source' | 'correlated' | 'inferred';
  /** An opaque provider-local reference; it is not a filesystem path. */
  opaqueRef?: string;
}

export interface NavigationRelation {
  sourceId: string;
  fromNativeId: string;
  toNativeId: string;
  kind: NavigationRelationKind;
}

export interface NavigationSnapshot {
  snapshotId: string;
  sourceId: string;
  sourceGeneration: string;
  capturedAt: string;
  redaction: 'metadata-only';
  entities: readonly NavigationEntity[];
  relations: readonly NavigationRelation[];
  truncated: boolean;
  truncatedReason?: 'entity_limit' | 'relation_limit' | 'record_limit' | 'diagnostic_limit' | 'time_limit';
}

export interface NavigationBudget {
  maxEntities?: number;
  maxRelations?: number;
  maxRecords?: number;
  maxDiagnostics?: number;
  maxMilliseconds?: number;
}

export interface NavigationQuery {
  sourceId?: string;
  snapshotId?: string;
  /** Bounded entity offset used by transport adapters for snapshot paging. */
  offset?: number;
  kind?: NavigationEntityKind;
  parentNativeId?: string;
  text?: string;
  limit?: number;
  budget?: NavigationBudget;
}

export interface NavigationQueryResult {
  protocolVersion: typeof NAVIGATION_PROTOCOL_VERSION;
  operationId: string;
  snapshotId: string;
  sourceId: string;
  entities: readonly NavigationEntity[];
  relations: readonly NavigationRelation[];
  examinedEntities: number;
  examinedRelations: number;
  truncated: boolean;
  truncatedReason?: 'entity_limit' | 'relation_limit' | 'record_limit' | 'diagnostic_limit' | 'time_limit' | 'result_limit';
}

export interface NavigationProvider {
  readonly sourceId: string;
  /** Read a bounded immutable projection. Providers must not mutate their source. */
  readSnapshot(signal: AbortSignal, budget: Required<NavigationBudget>): Promise<NavigationSnapshot>;
}
