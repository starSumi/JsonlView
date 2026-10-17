import { describe, expect, it } from 'vitest';
import {
  isNavigatorBridgeResult,
  isSourceRegistrationFacts,
  type NavigatorBridgeResultV1,
  type SourceRegistrationFactsV1,
} from '../../src/shared/protocol';
import { isExtensionMessage } from '../../src/shared/transport';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { validateWebviewRequest } from '../../src/extension/message-validation';

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
    })).toBe(true);
  });

  it('rejects a result that claims open without a target or a failed result without failure metadata', () => {
    expect(isNavigatorBridgeResult({
      version: 1, status: 'opened', enabled: 'enabled', authorization: 'granted',
      authorizationReadback: 'confirmed', action: 'focus-sessions',
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
});
