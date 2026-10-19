/**
 * Application-owned catalog vocabulary. These shapes intentionally contain
 * metadata and physical anchors only; source record bodies remain owned by the
 * JSONL engine and are never copied into the catalog.
 */

export type CatalogSourceKind = 'provider_home' | 'folder' | 'exact_file';
export type CatalogAuthorizationState = 'authorized' | 'revoked' | 'unknown';
export type CatalogAvailabilityState = 'available' | 'missing' | 'unknown';
export type CatalogPlane = 'metadata' | 'entity';
export type CatalogCheckpointState = 'pending' | 'ready' | 'stale' | 'failed' | 'disabled';
export type CatalogProviderId = 'codex' | 'claude' | 'pi' | 'kimi' | 'gemini' | 'opencode' | 'agentsview' | 'generic';
export type CatalogEntityKind = 'source' | 'session' | 'thread' | 'turn' | 'workflow' | 'team' | 'tool' | 'goal' | 'plan' | 'memory' | 'task' | 'subagent' | 'event' | 'other';
export type CatalogRelationKind = 'parent' | 'child' | 'fork' | 'spawn' | 'contains' | 'uses';
export type CatalogTitleSource = 'product' | 'provider' | 'first-message' | 'id';
export type CatalogRelationship = 'root' | 'subagent' | 'fork' | 'continuation' | 'orphan' | 'generic';
export type CatalogSortKey = 'activity' | 'created' | 'title';

export interface CatalogEntityInput {
  readonly sourceId: string;
  readonly nativeId: string;
  readonly kind: CatalogEntityKind;
  readonly label: string;
  readonly vendorTitle?: string;
  readonly productTitle?: string;
  readonly titleSource?: CatalogTitleSource;
  readonly firstMessagePreview?: string;
  readonly startedAt?: string;
  readonly activityAt?: string;
  readonly relationship?: CatalogRelationship;
  readonly project?: string;
  readonly parentNativeId?: string;
  readonly updatedAt?: string;
  readonly status?: string;
  readonly confidence: 'source' | 'correlated' | 'inferred';
  readonly opaqueRef?: string;
}

export interface CatalogEntity extends CatalogEntityInput {
  readonly generation: string;
  readonly provider: CatalogProviderId;
}

export interface CatalogRelation {
  readonly sourceId: string;
  readonly fromNativeId: string;
  readonly toNativeId: string;
  readonly kind: CatalogRelationKind;
}

export interface CatalogLocation {
  readonly nativeId: string;
  readonly relativePath: string;
  readonly rowOrdinal: string;
}

export interface CatalogSnapshot {
  readonly schemaVersion: 1;
  readonly provider: CatalogProviderId;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly redaction: 'metadata-only';
  readonly entities: readonly CatalogEntityInput[];
  readonly relations: readonly CatalogRelation[];
  readonly locations: readonly CatalogLocation[];
  readonly truncated: boolean;
  readonly truncatedReason?: 'entity_limit' | 'relation_limit' | 'record_limit' | 'diagnostic_limit' | 'time_limit';
  readonly nextCursor?: string;
}

export interface CatalogStoredSnapshot extends Omit<CatalogSnapshot, 'entities'> {
  readonly entities: readonly CatalogEntity[];
}

export interface CatalogSourceSummary {
  readonly sourceId: string;
  readonly provider: CatalogProviderId;
  readonly label: string;
  readonly generation: string;
  readonly capturedAt?: string;
  readonly entityCount: number;
  readonly relationCount: number;
  readonly updateAvailable: boolean;
  readonly truncated?: boolean;
  readonly nextCursor?: string;
  readonly lastActivityAt?: string;
}

export interface CatalogNavigatorSourceSetting {
  readonly provider: CatalogProviderId;
  readonly rootUri: string;
  readonly stateRootUri?: string;
}

export interface CatalogSourcePageState {
  readonly generation: string;
  readonly nextCursor?: string;
  readonly fingerprint?: string;
}

export interface CatalogChildrenPage {
  readonly entities: readonly CatalogEntity[];
  readonly generation: string;
  readonly nextCursor?: string;
}

export interface CatalogChildrenPageOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CatalogAppendGuard {
  readonly expectedGeneration: string;
  readonly expectedCursor: string;
  readonly expectedFingerprint?: string;
  readonly signal?: AbortSignal;
}

export interface CatalogContinuationExpectation {
  readonly generation: string;
  readonly cursor: string;
  readonly fingerprint: string;
}

export interface CatalogSourceMetadata {
  readonly sourceId: string;
  readonly providerId: string;
  readonly sourceKind: CatalogSourceKind;
  readonly canonicalUri: string;
  readonly displayLabel: string;
  readonly configRevision: string;
  readonly authorizationState: CatalogAuthorizationState;
  readonly availabilityState: CatalogAvailabilityState;
  readonly metadataState: CatalogCheckpointState;
  readonly entityScanState: CatalogCheckpointState;
  readonly fingerprint?: string;
  readonly sizeBytes?: string;
  readonly modifiedAt?: string;
  readonly createdAt: string;
  readonly verifiedAt?: string;
  readonly errorCode?: string;
}

export interface CatalogSourceInput {
  readonly sourceId: string;
  readonly providerId: string;
  readonly sourceKind: CatalogSourceKind;
  readonly canonicalUri: string;
  readonly displayLabel: string;
  readonly configRevision: string;
  readonly authorizationState: CatalogAuthorizationState;
  readonly availabilityState?: CatalogAvailabilityState;
}

export interface CatalogCheckpoint {
  readonly sourceId: string;
  readonly plane: CatalogPlane;
  readonly scanEpoch: string;
  readonly configRevision: string;
  readonly state: CatalogCheckpointState;
  readonly cursor?: string;
  readonly fingerprint?: string;
  readonly terminalCode?: string;
  readonly committedAt?: string;
}
