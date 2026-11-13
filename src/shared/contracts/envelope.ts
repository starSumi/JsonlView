import type { DocumentGraphReply, GraphRevealReceipt, GraphRevealRequest } from './document-graph';
import type { LineageLookupReply, LineageLookupRequest } from './lineage';
import type { AnalysisIntentV1, InsightSummary, Predicate, RowProjectionPlan, RowScanBudget, RowSort } from './query';
import type { ColumnSpec, DocumentSummary, FieldStats, ProblemPage, RecordDetail, RecordRef, RowPage, TemporaryPreviewStatus } from './record';
import { isProtocolDirection, MAX_PROTOCOL_DOCUMENT_ID_LENGTH, MAX_PROTOCOL_GENERATION_LENGTH, MAX_PROTOCOL_REQUEST_ID_LENGTH,
  PROTOCOL_VERSION, type ProtocolDelivery, type ProtocolDirection, type ProtocolIdentity } from './identity';
import type { NavigatorBridgeResultV1, SourceRegistrationFactsV1 } from './navigation';
import type { RevealAckPayload } from './reveal';

export type { ProtocolDelivery, ProtocolDirection, ProtocolIdentity };

export const MAX_DIAGNOSTIC_CODE_LENGTH = 128;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;

export interface ProtocolEnvelope<TType extends string, TPayload> extends ProtocolIdentity {
  protocolVersion: typeof PROTOCOL_VERSION;
  /** Optional on legacy v1 messages; new callers set a direction-specific value. */
  direction?: ProtocolDirection;
  /** Optional only for v1 compatibility. New Webview requests and Host messages are explicit. */
  delivery?: ProtocolDelivery;
  type: TType;
  epoch?: number;
  payload: TPayload;
}

export interface ProtocolEnvelopeInput<TType extends string, TPayload> extends ProtocolIdentity {
  type: TType;
  payload: TPayload;
  epoch?: number;
  direction?: ProtocolDirection;
  delivery?: ProtocolDelivery;
}

export type ProtocolEnvelopeValidation =
  | { ok: true; envelope: ProtocolEnvelope<string, Record<string, unknown>> }
  | { ok: false; error: string };

export type WebviewRequest =
  | ProtocolEnvelope<'LOOKUP_LINEAGE_RECORD', LineageLookupRequest>
  | ProtocolEnvelope<'GET_GRAPH', Record<string, never>>
  | ProtocolEnvelope<'REVEAL_GRAPH_RECORD', GraphRevealRequest>
  | ProtocolEnvelope<'REVEAL_ACK', RevealAckPayload>
  | ProtocolEnvelope<'READY', { restoredState?: unknown }>
  | ProtocolEnvelope<'GET_ROWS', {
    anchorOrdinal?: string; direction?: 'forward' | 'backward'; limit: number; predicate?: Predicate;
    columns?: ColumnSpec[]; projection?: RowProjectionPlan; sort?: RowSort; sortOffset?: string; scanBudget?: RowScanBudget;
  }>
  | ProtocolEnvelope<'GET_PROBLEMS', { anchorOrdinal?: string; direction?: 'forward' | 'backward'; limit: number; scanBudget?: RowScanBudget }>
  | ProtocolEnvelope<'GET_DETAIL', { ref: RecordRef; full?: boolean }>
  | ProtocolEnvelope<'OPEN_RECORD_TEXT', { ref: RecordRef }>
  | ProtocolEnvelope<'GET_SCHEMA', { offset: number; limit: number }>
  | ProtocolEnvelope<'GET_INSIGHTS', { intent: AnalysisIntentV1 }>
  | ProtocolEnvelope<'SET_PROFILE', { profileId: string }>
  | ProtocolEnvelope<'SET_FOLLOW_MODE', { enabled: boolean }>
  | ProtocolEnvelope<'SET_ROW_ORDER', { direction: RowSort['direction'] }>
  | ProtocolEnvelope<'OPEN_SESSION_NAVIGATOR', Record<string, never>>
  | ProtocolEnvelope<'SAVE_PREVIEW_AS', Record<string, never>>
  | ProtocolEnvelope<'DIAGNOSE_ERROR', { code: string; message: string; action?: 'explain' | 'copy' }>
  | ProtocolEnvelope<'CANCEL', { targetRequestId: string }>
  | ProtocolEnvelope<'REBUILD_INDEX', Record<string, never>>;

export type ExtensionMessage =
  | ProtocolEnvelope<'LINEAGE_LOOKUP_RESULT', LineageLookupReply>
  | ProtocolEnvelope<'GRAPH', DocumentGraphReply>
  | ProtocolEnvelope<'GRAPH_REVEAL_RESULT', GraphRevealReceipt>
  | ProtocolEnvelope<'OPENED', DocumentSummary>
  | ProtocolEnvelope<'PREVIEW_STATUS', TemporaryPreviewStatus>
  | ProtocolEnvelope<'ROWS', RowPage>
  | ProtocolEnvelope<'PROBLEMS', ProblemPage>
  | ProtocolEnvelope<'DETAIL', RecordDetail>
  | ProtocolEnvelope<'SCHEMA', { fields: FieldStats[]; totalFields: number; complete: boolean }>
  | ProtocolEnvelope<'INSIGHTS', InsightSummary>
  | ProtocolEnvelope<'INDEX_PROGRESS', DocumentSummary>
  | ProtocolEnvelope<'PROFILE_CHANGED', { profileId: string; profileVersion?: string; profileEpoch?: number; columns: ColumnSpec[] }>
  | ProtocolEnvelope<'ROW_ORDER_CHANGED', { direction: RowSort['direction'] }>
  | ProtocolEnvelope<'REVEAL', { sourceId: string; generation: string; nativeId: string; anchorOrdinal: string }>
  | ProtocolEnvelope<'SOURCE_INVALIDATED', { reason: 'append' | 'truncate' | 'replace' | 'delete' | 'unknown' }>
  | ProtocolEnvelope<'ERROR', { code: string; message: string; recoverable: boolean }>
  | ProtocolEnvelope<'NAVIGATOR_STATUS', NavigatorBridgeResultV1>
  | ProtocolEnvelope<'NAVIGATOR_VISIBILITY', { visible: boolean }>
  | ProtocolEnvelope<'SOURCE_REGISTRATION_RESULT', SourceRegistrationFactsV1>;

export type HostBroadcastMessageType =
  | 'OPENED' | 'PREVIEW_STATUS' | 'INDEX_PROGRESS' | 'PROFILE_CHANGED' | 'SOURCE_INVALIDATED' | 'ERROR' | 'NAVIGATOR_VISIBILITY';
export type HostDeliveryFor<TType extends ExtensionMessage['type']> = TType extends 'REVEAL' ? 'request'
  : TType extends HostBroadcastMessageType ? 'reply' | 'broadcast' : 'reply';

/** Type for newly emitted Host messages; the compatibility receive shape above remains v1-tolerant. */
export type HostExtensionMessage =
  | (Extract<ExtensionMessage, { type: HostBroadcastMessageType }> & { delivery: 'reply' | 'broadcast' })
  | (Exclude<ExtensionMessage, { type: HostBroadcastMessageType | 'REVEAL' }> & { delivery: 'reply' })
  | (Extract<ExtensionMessage, { type: 'REVEAL' }> & { delivery: 'request' });
export type WebviewOutboundRequest =
  | (Exclude<WebviewRequest, { type: 'REVEAL_ACK' }> & { delivery: 'request' })
  | (Extract<WebviewRequest, { type: 'REVEAL_ACK' }> & { delivery: 'reply' });

/**
 * Exhaustive compile-time ownership of every wire discriminator.
 * Adding a union member without classifying its direction is a type error;
 * runtime lookup is also fail-closed for untrusted values.
 */
const MESSAGE_DIRECTIONS = {
  LOOKUP_LINEAGE_RECORD: 'webview-to-host',
  GET_GRAPH: 'webview-to-host',
  REVEAL_GRAPH_RECORD: 'webview-to-host',
  REVEAL_ACK: 'webview-to-host',
  READY: 'webview-to-host',
  GET_ROWS: 'webview-to-host',
  GET_PROBLEMS: 'webview-to-host',
  GET_DETAIL: 'webview-to-host',
  OPEN_RECORD_TEXT: 'webview-to-host',
  GET_SCHEMA: 'webview-to-host',
  GET_INSIGHTS: 'webview-to-host',
  SET_PROFILE: 'webview-to-host',
  SET_FOLLOW_MODE: 'webview-to-host',
  SET_ROW_ORDER: 'webview-to-host',
  OPEN_SESSION_NAVIGATOR: 'webview-to-host',
  SAVE_PREVIEW_AS: 'webview-to-host',
  DIAGNOSE_ERROR: 'webview-to-host',
  CANCEL: 'webview-to-host',
  REBUILD_INDEX: 'webview-to-host',
  LINEAGE_LOOKUP_RESULT: 'host-to-webview',
  GRAPH: 'host-to-webview',
  GRAPH_REVEAL_RESULT: 'host-to-webview',
  OPENED: 'host-to-webview',
  PREVIEW_STATUS: 'host-to-webview',
  ROWS: 'host-to-webview',
  PROBLEMS: 'host-to-webview',
  DETAIL: 'host-to-webview',
  SCHEMA: 'host-to-webview',
  INSIGHTS: 'host-to-webview',
  INDEX_PROGRESS: 'host-to-webview',
  PROFILE_CHANGED: 'host-to-webview',
  ROW_ORDER_CHANGED: 'host-to-webview',
  REVEAL: 'host-to-webview',
  SOURCE_INVALIDATED: 'host-to-webview',
  ERROR: 'host-to-webview',
  NAVIGATOR_STATUS: 'host-to-webview',
  NAVIGATOR_VISIBILITY: 'host-to-webview',
  SOURCE_REGISTRATION_RESULT: 'host-to-webview',
} satisfies Record<WebviewRequest['type'] | ExtensionMessage['type'], ProtocolDirection>;

export type WebviewRequestType = WebviewRequest['type'];
export type ExtensionMessageType = ExtensionMessage['type'];

export function isWebviewRequestType(value: unknown): value is WebviewRequestType {
  return typeof value === 'string' && Object.hasOwn(MESSAGE_DIRECTIONS, value)
    && MESSAGE_DIRECTIONS[value as keyof typeof MESSAGE_DIRECTIONS] === 'webview-to-host';
}
export function isExtensionMessageType(value: unknown): value is ExtensionMessageType {
  return typeof value === 'string' && Object.hasOwn(MESSAGE_DIRECTIONS, value)
    && MESSAGE_DIRECTIONS[value as keyof typeof MESSAGE_DIRECTIONS] === 'host-to-webview';
}
export function directionForMessageType(value: unknown): ProtocolDirection | undefined {
  if (typeof value !== 'string' || !Object.hasOwn(MESSAGE_DIRECTIONS, value)) return undefined;
  return MESSAGE_DIRECTIONS[value as keyof typeof MESSAGE_DIRECTIONS];
}
export function isMessageDirection(value: unknown, direction: ProtocolDirection): boolean {
  const expected = directionForMessageType(value);
  return expected !== undefined && expected === direction;
}

export function validateProtocolEnvelope(value: unknown): ProtocolEnvelopeValidation {
  if (!isRecord(value)) return { ok: false, error: 'Message must be an object.' };
  if (value.protocolVersion !== PROTOCOL_VERSION) return { ok: false, error: 'Unsupported protocol version.' };
  if (value.direction !== undefined && !isProtocolDirection(value.direction)) return { ok: false, error: 'Direction is invalid.' };
  if (value.delivery !== undefined && !isDelivery(value.delivery)) return { ok: false, error: 'Delivery is invalid.' };
  if (!isBoundedString(value.type, 64)) return { ok: false, error: 'Message type is required.' };
  if (!isBoundedString(value.documentId, MAX_PROTOCOL_DOCUMENT_ID_LENGTH)
    || !isBoundedString(value.generation, MAX_PROTOCOL_GENERATION_LENGTH)) return { ok: false, error: 'Document identity is required.' };
  if (value.epoch !== undefined && !isSafeNonNegativeInteger(value.epoch)) return { ok: false, error: 'Epoch must be a non-negative safe integer.' };
  if (typeof value.requestId !== 'string' || value.requestId.length > MAX_PROTOCOL_REQUEST_ID_LENGTH) return { ok: false, error: 'Request id is required.' };
  if (value.requestId.length === 0 && value.delivery !== 'broadcast') return { ok: false, error: 'Broadcast delivery is required for an empty request id.' };
  if (value.delivery === 'broadcast' && value.requestId.length !== 0) return { ok: false, error: 'Broadcast delivery requires an empty request id.' };
  if (value.delivery === 'broadcast' && value.direction === 'webview-to-host') return { ok: false, error: 'Broadcast delivery is host-to-Webview only.' };
  if (!isRecord(value.payload)) return { ok: false, error: 'Payload must be an object.' };
  return { ok: true, envelope: value as unknown as ProtocolEnvelope<string, Record<string, unknown>> };
}

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope<string, Record<string, unknown>> {
  return validateProtocolEnvelope(value).ok;
}

export function readProtocolIdentity(value: unknown): ProtocolIdentity {
  if (!isRecord(value)) return { documentId: 'unknown', generation: 'unknown', requestId: 'unknown' };
  return {
    documentId: readIdentityPart(value.documentId, MAX_PROTOCOL_DOCUMENT_ID_LENGTH),
    generation: readIdentityPart(value.generation, MAX_PROTOCOL_GENERATION_LENGTH),
    requestId: readIdentityPart(value.requestId, MAX_PROTOCOL_REQUEST_ID_LENGTH, true),
  };
}

function readIdentityPart(value: unknown, maxLength: number, allowEmpty = false): string {
  return typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0) ? 'unknown' : value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isBoundedString(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit; }
function isSafeNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isDelivery(value: unknown): value is ProtocolDelivery { return value === 'request' || value === 'reply' || value === 'broadcast'; }
