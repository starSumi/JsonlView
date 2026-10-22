import { describe, expect, it } from 'vitest';
import type { ExtensionMessage, RowPage, WebviewRequest } from '../../src/shared/types';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { RowQueryController as RootRowQueryController } from '../../src/webview/row-query-controller';
import { RowQueryController as FeatureRowQueryController } from '../../src/webview/features/record-query/row-query-controller';
import {
  captureRebuild as rootCaptureRebuild,
  planOpened as rootPlanOpened,
} from '../../src/webview/row-query-recovery-policy';
import {
  captureRebuild as featureCaptureRebuild,
  planOpened as featurePlanOpened,
} from '../../src/webview/features/record-query/row-query-recovery-policy';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';

const rowPage: RowPage = {
  rows: [], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '0',
};

function rowsMessage(
  requestId: string,
  identity: { documentId: string; generation: string; epoch?: number },
): Extract<ExtensionMessage, { type: 'ROWS' }> {
  return {
    protocolVersion: PROTOCOL_VERSION, type: 'ROWS', ...identity, requestId, payload: rowPage,
  };
}

describe('cross-boundary protocol contracts', () => {
  it.each([
    { name: 'document', identity: { documentId: 'other', generation: 'g1', epoch: 1 } },
    { name: 'generation', identity: { documentId: 'doc', generation: 'g0', epoch: 1 } },
    { name: 'epoch', identity: { documentId: 'doc', generation: 'g1', epoch: 0 } },
  ])('rejects a correlated ROWS reply with a stale $name identity', ({ identity }) => {
    const client = new VsCodeMessageClient({ postMessage() {} }, { documentId: 'doc', generation: 'g1', epoch: 1 });
    const request = client.send('GET_ROWS', { limit: 100 });

    expect(client.accept(rowsMessage(request.id, identity))).toBeUndefined();
    expect(client.hasPending('rows')).toBe(true);
  });

  it('does not publish a late ROWS reply after cancellation removed its pending request', () => {
    const sent: WebviewRequest[] = [];
    const client = new VsCodeMessageClient({ postMessage: (message) => sent.push(message) }, {
      documentId: 'doc', generation: 'g1', epoch: 1,
    });
    const request = client.send('GET_ROWS', { limit: 100 });

    expect(client.cancel('rows')).toEqual([request.id]);
    expect(sent.at(-1)).toMatchObject({ type: 'CANCEL', payload: { targetRequestId: request.id } });
    expect(client.accept(rowsMessage(request.id, { documentId: 'doc', generation: 'g1', epoch: 1 }))).toBeUndefined();
    expect(client.hasPending('rows')).toBe(false);
  });
});

describe('record-query compatibility boundaries', () => {
  it('keeps the root controller entry point as the feature controller identity', () => {
    expect(RootRowQueryController).toBe(FeatureRowQueryController);
  });

  it('keeps root recovery exports as the feature policy identity', () => {
    expect(rootCaptureRebuild).toBe(featureCaptureRebuild);
    expect(rootPlanOpened).toBe(featurePlanOpened);
  });
});
