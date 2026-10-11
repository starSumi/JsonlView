import { PROTOCOL_VERSION, type ProtocolEnvelope } from '../types';

export const MAX_PROTOCOL_DOCUMENT_ID_LENGTH = 256;
export const MAX_PROTOCOL_GENERATION_LENGTH = 256;
export const MAX_PROTOCOL_REQUEST_ID_LENGTH = 128;

export type ProtocolIdentity = Pick<
  ProtocolEnvelope<string, unknown>,
  'documentId' | 'generation' | 'requestId'
>;

export interface ProtocolEnvelopeInput<TType extends string, TPayload> extends ProtocolIdentity {
  type: TType;
  payload: TPayload;
  epoch?: number;
}

export type ProtocolEnvelopeValidation =
  | { ok: true; envelope: ProtocolEnvelope<string, Record<string, unknown>> }
  | { ok: false; error: string };

/**
 * Creates the common wire envelope used by both Extension Host and Webview.
 * Keeping version stamping here prevents a caller from accidentally emitting
 * an unversioned message while preserving the existing message unions.
 */
export function createProtocolEnvelope<TType extends string, TPayload>(
  input: ProtocolEnvelopeInput<TType, TPayload>,
): ProtocolEnvelope<TType, TPayload> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: input.type,
    documentId: input.documentId,
    generation: input.generation,
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    requestId: input.requestId,
    payload: input.payload,
  };
}

/**
 * Validates only the shared transport header. Direction-specific validators
 * remain responsible for the message type and payload contract.
 */
export function validateProtocolEnvelope(value: unknown): ProtocolEnvelopeValidation {
  if (!isRecord(value)) {
    return { ok: false, error: 'Message must be an object.' };
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, error: 'Unsupported protocol version.' };
  }
  if (!isBoundedString(value.type, 64)) {
    return { ok: false, error: 'Message type is required.' };
  }
  if (!isBoundedString(value.documentId, MAX_PROTOCOL_DOCUMENT_ID_LENGTH)
    || !isBoundedString(value.generation, MAX_PROTOCOL_GENERATION_LENGTH)) {
    return { ok: false, error: 'Document identity is required.' };
  }
  if (value.epoch !== undefined
    && (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0)) {
    return { ok: false, error: 'Epoch must be a non-negative safe integer.' };
  }
  // An empty request id is valid for host broadcasts; request validators may
  // impose correlation requirements for inbound Webview requests.
  if (typeof value.requestId !== 'string' || value.requestId.length > MAX_PROTOCOL_REQUEST_ID_LENGTH) {
    return { ok: false, error: 'Request id is required.' };
  }
  if (!isRecord(value.payload)) {
    return { ok: false, error: 'Payload must be an object.' };
  }
  return {
    ok: true,
    envelope: value as unknown as ProtocolEnvelope<string, Record<string, unknown>>,
  };
}

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope<string, Record<string, unknown>> {
  return validateProtocolEnvelope(value).ok;
}

export function readProtocolIdentity(value: unknown): ProtocolIdentity {
  if (!isRecord(value)) {
    return { documentId: 'unknown', generation: 'unknown', requestId: 'unknown' };
  }
  return {
    documentId: readIdentityPart(value.documentId, MAX_PROTOCOL_DOCUMENT_ID_LENGTH),
    generation: readIdentityPart(value.generation, MAX_PROTOCOL_GENERATION_LENGTH),
    requestId: readIdentityPart(value.requestId, MAX_PROTOCOL_REQUEST_ID_LENGTH, true),
  };
}

function readIdentityPart(value: unknown, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    return 'unknown';
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
