export * from './navigator-bridge';
export * from './source-registration';

/** Versioned, redacted records for the optional local agent navigator. */
export const NAVIGATION_PROTOCOL_VERSION = 1 as const;

export type NavigationEntityKind =
  | 'source' | 'session' | 'thread' | 'turn' | 'workflow' | 'team' | 'tool' | 'goal' | 'plan'
  | 'memory' | 'task' | 'subagent' | 'event' | 'other';

export type NavigationRelationKind = 'parent' | 'child' | 'fork' | 'spawn' | 'contains' | 'uses';
export type NavigationTitleSource = 'product' | 'provider' | 'first-message' | 'id';
export type NavigationRelationship = 'root' | 'subagent' | 'fork' | 'continuation' | 'orphan' | 'generic';

export interface NavigationEntity {
  sourceId: string;
  nativeId: string;
  kind: NavigationEntityKind;
  label: string;
  vendorTitle?: string;
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
  /** Opaque provider-local reference; never a filesystem path. */
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
