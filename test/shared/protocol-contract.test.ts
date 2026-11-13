import { describe, expect, it, vi } from 'vitest';
import {
  isMessageDirection,
  isNavigatorBridgeResult,
  isSourceRegistrationFacts,
  type NavigatorBridgeResultV1,
  type SourceRegistrationFactsV1,
} from '../../src/shared/protocol';
import { isExtensionMessage } from '../../src/shared/transport';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { validateWebviewRequest } from '../../src/extension/message-validation';
import { validateWebviewRequest as validateWebviewRequestContract } from '../../src/shared/contracts/webview-request';
import { isRowProjectionPlan } from '../../src/shared/contracts/query';
import { isRowProjectionPlan as isLegacyRowProjectionPlan } from '../../src/shared/row-projection';

const failure = { errorCode: 'AUTHORIZATION_NOT_CONFIRMED' as const, stage: 'authorization' as const, recoverable: true };

describe('shared protocol contract', () => {
  it('accepts a Navigator guide result with persisted authorization readback facets', () => {
    const value: NavigatorBridgeResultV1 = {
      version: 1,
      status: 'authorization-required',
      enabled: 'enabled',
      authorization: 'required',
      authorizationReadback: 'not-requested',
      action: 'request-authorization',
    };
    expect(isNavigatorBridgeResult(value)).toBe(true);
  });

  it('accepts a successful Navigator open only after authorization is confirmed', () => {
    expect(isNavigatorBridgeResult({
      version: 1,
      status: 'opened',
      enabled: 'enabled',
      authorization: 'granted',
      authorizationReadback: 'confirmed',
      action: 'focus-sessions',
      sourceId: 'source-1',
      targetDocumentId: 'document-1',
    })).toBe(true);
  });

  it('allows opening the empty Navigator without source authorization', () => {
    expect(isNavigatorBridgeResult({
      version: 1, status: 'opened', enabled: 'enabled', authorization: 'not-requested',
      authorizationReadback: 'not-requested', action: 'focus-sessions',
    })).toBe(true);
  });

  it('rejects an opened result with mismatched target identity or missing failure metadata', () => {
    expect(isNavigatorBridgeResult({
      version: 1, status: 'opened', enabled: 'enabled', authorization: 'granted',
      authorizationReadback: 'confirmed', action: 'focus-sessions', sourceId: 'source-1',
    })).toBe(false);
    expect(isNavigatorBridgeResult({
      version: 1, status: 'failed', enabled: 'enabled', authorization: 'granted',
      authorizationReadback: 'confirmed', action: 'none',
    })).toBe(false);
  });

  it('keeps Save As outcomes independent and preserves unknown readback', () => {
    const value: SourceRegistrationFactsV1 = {
      version: 1,
      operationId: 'op-1',
      sourceUri: 'file:///tmp/example.jsonl',
      fileSaved: { state: 'saved', destinationUri: 'file:///tmp/example.jsonl' },
      sourceRegistered: { state: 'unknown', readback: 'unknown', failure: { errorCode: 'source-config-readback-unknown', stage: 'source-config-readback', recoverable: true } },
      catalogState: { state: 'entity-scan-disabled' },
      openState: { state: 'not-requested' },
    };
    expect(isSourceRegistrationFacts(value)).toBe(true);
    expect(isSourceRegistrationFacts({ ...value, sourceRegistered: { state: 'registered', readback: 'confirmed' } })).toBe(false);
  });

  it('validates new result messages in the host-to-Webview direction', () => {
    expect(isExtensionMessage({
      protocolVersion: PROTOCOL_VERSION,
      direction: 'host-to-webview',
      delivery: 'reply',
      type: 'NAVIGATOR_STATUS',
      documentId: 'document', generation: 'generation', requestId: 'request',
      payload: {
        version: 1, status: 'authorization-denied', enabled: 'enabled', authorization: 'denied',
        authorizationReadback: 'rejected', action: 'focus-add-source', errorCode: failure.errorCode, stage: failure.stage, recoverable: failure.recoverable,
      },
    })).toBe(true);
    expect(isExtensionMessage({
      protocolVersion: PROTOCOL_VERSION,
      direction: 'webview-to-host',
      type: 'NAVIGATOR_STATUS',
      documentId: 'document', generation: 'generation', requestId: 'request',
      payload: {
        version: 1, status: 'authorization-denied', enabled: 'enabled', authorization: 'denied',
        authorizationReadback: 'rejected', action: 'focus-add-source', errorCode: failure.errorCode, stage: failure.stage, recoverable: failure.recoverable,
      },
    })).toBe(false);
  });

  it('rejects a host-to-Webview direction on an inbound request', () => {
    expect(validateWebviewRequest({
      protocolVersion: PROTOCOL_VERSION, direction: 'host-to-webview', type: 'OPEN_SESSION_NAVIGATOR',
      documentId: 'document', generation: 'generation', requestId: 'request', payload: {},
    }).ok).toBe(false);
  });

  it('fails closed for message discriminators with no registered direction', () => {
    expect(isMessageDirection('NOT_REGISTERED', 'webview-to-host')).toBe(false);
    expect(isMessageDirection('NOT_REGISTERED', 'host-to-webview')).toBe(false);
    expect(isMessageDirection('OPEN_SESSION_NAVIGATOR', 'webview-to-host')).toBe(true);
    expect(isMessageDirection('OPEN_SESSION_NAVIGATOR', 'host-to-webview')).toBe(false);
  });

  it('owns the projection shape guard in the query contract and keeps the compatibility export', () => {
    const valid = { conversation: true, dataset: false };
    const invalid = { ...valid, extra: true };
    expect(isRowProjectionPlan(valid)).toBe(true);
    expect(isLegacyRowProjectionPlan(valid)).toBe(true);
    expect(isRowProjectionPlan(invalid)).toBe(false);
    expect(isLegacyRowProjectionPlan(invalid)).toBe(false);
  });

  it('keeps request format checks deterministic and applies deadline horizons at the Host boundary', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const request = (deadlineEpochMs: number) => ({
      protocolVersion: PROTOCOL_VERSION,
      direction: 'webview-to-host',
      delivery: 'request',
      type: 'GET_ROWS',
      documentId: 'document',
      generation: 'generation',
      requestId: 'request',
      payload: { limit: 10, scanBudget: { deadlineEpochMs } },
    });
    try {
      expect(validateWebviewRequestContract(request(61_001)).ok).toBe(true);
      expect(validateWebviewRequestContract(request(61_001), { nowEpochMs: 1_000 }).ok).toBe(false);
      expect(validateWebviewRequestContract(request(61_000), { nowEpochMs: 1_000 }).ok).toBe(true);
      expect(validateWebviewRequest(request(61_001)).ok).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});
