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
