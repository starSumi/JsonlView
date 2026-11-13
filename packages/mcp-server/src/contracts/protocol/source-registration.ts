import {
  hasOnlyKeys,
  isBoundedProtocolString,
  isProtocolFailure,
  isRecord,
  MAX_PROTOCOL_OPERATION_ID_LENGTH,
  MAX_PROTOCOL_REVISION_LENGTH,
  MAX_PROTOCOL_SOURCE_ID_LENGTH,
  MAX_PROTOCOL_SOURCE_URI_LENGTH,
  SHARED_CONTRACT_VERSION,
  type ProtocolFailure,
  type SharedContractVersion,
} from './wire.js';

export type FileSavedState = 'not-requested' | 'pending' | 'saved' | 'cancelled' | 'failed' | 'unknown';
export type SourceRegisteredState =
  | 'not-requested'
  | 'pending'
  | 'registered'
  | 'already-registered'
  | 'cancelled'
  | 'conflict'
  | 'failed'
  | 'unknown';
export type CatalogState =
  | 'not-requested'
  | 'source-metadata-pending'
  | 'source-metadata-ready'
  | 'source-metadata-stale'
  | 'entity-scan-disabled'
  | 'entity-scan-pending'
  | 'entity-index-ready'
  | 'entity-index-stale'
  | 'failed'
  | 'unknown';
export type OpenState = 'not-requested' | 'pending' | 'opened' | 'cancelled' | 'failed' | 'unknown';

export interface FileSavedFact {
  state: FileSavedState;
  destinationUri?: string;
  failure?: ProtocolFailure;
}

export interface SourceRegisteredFact {
  state: SourceRegisteredState;
  sourceId?: string;
  sourceUri?: string;
  configRevision?: string;
  readback: 'not-requested' | 'pending' | 'confirmed' | 'conflict' | 'unknown';
  failure?: ProtocolFailure;
}

export interface CatalogStateFact {
  state: CatalogState;
  sourceId?: string;
  catalogRevision?: string;
  failure?: ProtocolFailure;
}

export interface OpenStateFact {
  state: OpenState;
  documentId?: string;
  generation?: string;
  epoch?: number;
  failure?: ProtocolFailure;
}

/**
 * Independent outcomes of a Save As/source-registration flow. A successful
 * file write does not imply configuration readback, a catalog index, or an
 * editor open. Unknown is a first-class outcome until the owning side reads
 * its authoritative state.
 */
export interface SourceRegistrationFactsV1 {
  version: SharedContractVersion;
  operationId: string;
  sourceId?: string;
  sourceUri?: string;
  fileSaved: FileSavedFact;
  sourceRegistered: SourceRegisteredFact;
  catalogState: CatalogStateFact;
  openState: OpenStateFact;
}

export function isSourceRegistrationFacts(value: unknown): value is SourceRegistrationFactsV1 {
  if (!isRecord(value)
    || value.version !== SHARED_CONTRACT_VERSION
    || !isBoundedProtocolString(value.operationId, MAX_PROTOCOL_OPERATION_ID_LENGTH)
    || !hasOnlyKeys(value, ['version', 'operationId', 'sourceId', 'sourceUri', 'fileSaved', 'sourceRegistered', 'catalogState', 'openState'])
    || (value.sourceId !== undefined && !isBoundedProtocolString(value.sourceId, MAX_PROTOCOL_SOURCE_ID_LENGTH))
    || (value.sourceUri !== undefined && !isBoundedProtocolString(value.sourceUri, MAX_PROTOCOL_SOURCE_URI_LENGTH))
    || !isFileSavedFact(value.fileSaved)
    || !isSourceRegisteredFact(value.sourceRegistered)
    || !isCatalogStateFact(value.catalogState)
    || !isOpenStateFact(value.openState)) return false;
  return true;
}

function isFileSavedFact(value: unknown): value is FileSavedFact {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'destinationUri', 'failure'])
    || !isOneOf(value.state, ['not-requested', 'pending', 'saved', 'cancelled', 'failed', 'unknown'])
    || (value.destinationUri !== undefined && !isBoundedProtocolString(value.destinationUri, MAX_PROTOCOL_SOURCE_URI_LENGTH))
    || (value.failure !== undefined && !isProtocolFailure(value.failure))) return false;
  if (value.state === 'saved' && value.destinationUri === undefined) return false;
  if ((value.state === 'failed' || value.state === 'cancelled' || value.state === 'unknown') && value.failure === undefined) return false;
  return true;
}

function isSourceRegisteredFact(value: unknown): value is SourceRegisteredFact {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'sourceId', 'sourceUri', 'configRevision', 'readback', 'failure'])
    || !isOneOf(value.state, ['not-requested', 'pending', 'registered', 'already-registered', 'cancelled', 'conflict', 'failed', 'unknown'])
    || !isOneOf(value.readback, ['not-requested', 'pending', 'confirmed', 'conflict', 'unknown'])
    || (value.sourceId !== undefined && !isBoundedProtocolString(value.sourceId, MAX_PROTOCOL_SOURCE_ID_LENGTH))
    || (value.sourceUri !== undefined && !isBoundedProtocolString(value.sourceUri, MAX_PROTOCOL_SOURCE_URI_LENGTH))
    || (value.configRevision !== undefined && !isBoundedProtocolString(value.configRevision, MAX_PROTOCOL_REVISION_LENGTH))
    || (value.failure !== undefined && !isProtocolFailure(value.failure))) return false;
  if ((value.state === 'registered' || value.state === 'already-registered') && value.sourceId === undefined) return false;
  if ((value.state === 'failed' || value.state === 'cancelled' || value.state === 'conflict' || value.state === 'unknown') && value.failure === undefined) return false;
  return true;
}

function isCatalogStateFact(value: unknown): value is CatalogStateFact {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'sourceId', 'catalogRevision', 'failure'])
    || !isOneOf(value.state, ['not-requested', 'source-metadata-pending', 'source-metadata-ready', 'source-metadata-stale', 'entity-scan-disabled', 'entity-scan-pending', 'entity-index-ready', 'entity-index-stale', 'failed', 'unknown'])
    || (value.sourceId !== undefined && !isBoundedProtocolString(value.sourceId, MAX_PROTOCOL_SOURCE_ID_LENGTH))
    || (value.catalogRevision !== undefined && !isBoundedProtocolString(value.catalogRevision, MAX_PROTOCOL_REVISION_LENGTH))
    || (value.failure !== undefined && !isProtocolFailure(value.failure))) return false;
  if ((value.state === 'failed' || value.state === 'unknown') && value.failure === undefined) return false;
  return true;
}

function isOpenStateFact(value: unknown): value is OpenStateFact {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'documentId', 'generation', 'epoch', 'failure'])
    || !isOneOf(value.state, ['not-requested', 'pending', 'opened', 'cancelled', 'failed', 'unknown'])
    || (value.documentId !== undefined && !isBoundedProtocolString(value.documentId, MAX_PROTOCOL_SOURCE_ID_LENGTH))
    || (value.generation !== undefined && !isBoundedProtocolString(value.generation, MAX_PROTOCOL_SOURCE_ID_LENGTH))
    || (value.epoch !== undefined && (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0))
    || (value.failure !== undefined && !isProtocolFailure(value.failure))) return false;
  if (value.state === 'opened' && (value.documentId === undefined || value.generation === undefined)) return false;
  if ((value.state === 'failed' || value.state === 'cancelled' || value.state === 'unknown') && value.failure === undefined) return false;
  return true;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}
