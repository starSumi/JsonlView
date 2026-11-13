import {
  hasOnlyKeys,
  isBoundedProtocolString,
  isRecord,
  MAX_PROTOCOL_SOURCE_ID_LENGTH,
  SHARED_CONTRACT_VERSION,
  type NavigatorErrorCode,
  type ProtocolStageCode,
  type SharedContractVersion,
} from './errors';

export type NavigatorBridgeStatus =
  | 'disabled'
  | 'authorization-required'
  | 'authorization-pending'
  | 'authorization-denied'
  | 'opened'
  | 'cancelled'
  | 'failed'
  | 'unknown';
export type NavigatorEnablement = 'disabled' | 'enabled' | 'unknown';
export type NavigatorAuthorization = 'not-requested' | 'required' | 'pending' | 'granted' | 'denied' | 'unknown';
export type NavigatorAuthorizationReadback = 'not-requested' | 'pending' | 'confirmed' | 'rejected' | 'unknown';
export type NavigatorBridgeAction =
  | 'focus-add-source'
  | 'focus-sessions'
  | 'request-enable'
  | 'request-authorization'
  | 'open-source'
  | 'none';
export type NavigatorStageCode = Extract<ProtocolStageCode, 'enablement' | 'authorization' | 'focus'>;

/**
 * Correlated host result for an explicit Open Navigator/locate action.
 * Enablement, authorization persistence, and opening are separate facets so
 * a guide result cannot be mistaken for a successful open.
 * Opening the empty Navigator is valid before any source is authorized; source authorization is
 * an explicit Add Source action owned by the Navigator surface.
 */
export interface NavigatorBridgeResultV1 {
  version: SharedContractVersion;
  status: NavigatorBridgeStatus;
  enabled: NavigatorEnablement;
  authorization: NavigatorAuthorization;
  authorizationReadback: NavigatorAuthorizationReadback;
  action: NavigatorBridgeAction;
  errorCode?: NavigatorErrorCode;
  stage?: NavigatorStageCode;
  recoverable?: boolean;
  sourceId?: string;
  targetDocumentId?: string;
}

export function isNavigatorBridgeResult(value: unknown): value is NavigatorBridgeResultV1 {
  if (!isRecord(value)
    || value.version !== SHARED_CONTRACT_VERSION
    || !hasOnlyKeys(value, ['version', 'status', 'enabled', 'authorization', 'authorizationReadback', 'action', 'errorCode', 'stage', 'recoverable', 'sourceId', 'targetDocumentId'])
    || !isOneOf(value.status, ['disabled', 'authorization-required', 'authorization-pending', 'authorization-denied', 'opened', 'cancelled', 'failed', 'unknown'])
    || !isOneOf(value.enabled, ['disabled', 'enabled', 'unknown'])
    || !isOneOf(value.authorization, ['not-requested', 'required', 'pending', 'granted', 'denied', 'unknown'])
    || !isOneOf(value.authorizationReadback, ['not-requested', 'pending', 'confirmed', 'rejected', 'unknown'])
    || !isOneOf(value.action, ['focus-add-source', 'focus-sessions', 'request-enable', 'request-authorization', 'open-source', 'none'])
    || (value.errorCode !== undefined && !isOneOf(value.errorCode, ['NAVIGATOR_DISABLED', 'ENABLEMENT_NOT_CONFIRMED', 'AUTHORIZATION_REQUIRED', 'AUTHORIZATION_NOT_CONFIRMED', 'OPEN_FAILED']))
    || (value.stage !== undefined && !isOneOf(value.stage, ['enablement', 'authorization', 'focus']))
    || (value.recoverable !== undefined && typeof value.recoverable !== 'boolean')
    || (value.sourceId !== undefined && !isBoundedProtocolString(value.sourceId, MAX_PROTOCOL_SOURCE_ID_LENGTH))
    || (value.targetDocumentId !== undefined && !isBoundedProtocolString(value.targetDocumentId, MAX_PROTOCOL_SOURCE_ID_LENGTH))
  ) return false;

  if (value.status === 'disabled' && value.enabled !== 'disabled') return false;
  if (value.status === 'authorization-required' && (value.enabled !== 'enabled' || value.authorization !== 'required')) return false;
  if (value.status === 'authorization-pending' && (value.enabled !== 'enabled' || value.authorization !== 'pending')) return false;
  if (value.status === 'authorization-denied' && value.authorization !== 'denied') return false;
  if (value.status === 'opened' && value.enabled !== 'enabled') return false;
  if (value.status === 'opened' && !isOneOf(value.authorization, ['not-requested', 'granted'])) return false;
  if (value.status === 'opened' && value.authorization === 'not-requested'
    && (value.authorizationReadback !== 'not-requested' || value.sourceId !== undefined || value.targetDocumentId !== undefined)) return false;
  if (value.status === 'opened' && value.authorization === 'granted'
    && value.authorizationReadback !== 'confirmed') return false;
  if (value.status === 'opened' && ((value.sourceId === undefined) !== (value.targetDocumentId === undefined))) return false;
  if (value.status === 'authorization-denied' && value.errorCode !== 'AUTHORIZATION_NOT_CONFIRMED') return false;
  if ((value.status === 'failed' || value.status === 'unknown')
    && (value.errorCode === undefined || value.stage === undefined || value.recoverable === undefined)) return false;
  return true;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}
