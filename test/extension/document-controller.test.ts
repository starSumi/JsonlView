import { describe, expect, it } from 'vitest';
import { DocumentController, type JsonlSessionPort, type MessageChannel } from '../../src/extension/document-controller';
import { PROTOCOL_VERSION, type DocumentSummary, type ExtensionMessage } from '../../src/shared/types';

function summary(): DocumentSummary {
  return {
    snapshot: {
      documentId: 'document',
      generation: 'generation',
      uri: 'file:///fixture.jsonl',
      scheme: 'file',
      sizeBytes: '0',
      mtimeMs: 0,
      prefixFingerprint: 'empty',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
    profileId: 'generic',
    profileSuggestions: [],
    indexedBytes: '0',
    indexedRecords: '0',
    indexingComplete: true,
    validRecords: '0',
    problemRecords: '0',
  };
}

function fakeSession(): JsonlSessionPort {
  const value = summary();
  return {
    getSummary: () => value,
    getRows: async () => ({
      rows: [],
      columns: [],
      anchorOrdinal: '0',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '0',
      totalRecords: '0',
    }),
    getDetail: async (ref) => ({
      ref,
      rawPreview: '',
      rawComplete: true,
      problems: [],
    }),
    getSchema: async () => ({ fields: [], totalFields: 0, complete: true }),
    getInsights: async (dimension) => ({
      dimension,
      categories: [],
      timeBuckets: [],
      processedRecords: '0',
      examinedRecords: '0',
      examinedBytes: '0',
      truncated: false,
      capacityReached: false,
      bucketWidthMs: 300_000,
    }),
    setProfile: async () => value,
    setFollowMode: async () => value,
    rebuild: async () => value,
  };
}

function request(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    documentId: 'document',
    generation: 'generation',
    requestId: `request-${type}`,
    payload,
  };
}

describe('document controller', () => {
  it('responds to READY with the current document summary', async () => {
    const messages: ExtensionMessage[] = [];
    const channel: MessageChannel = {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    };
    const controller = new DocumentController(fakeSession(), channel);
    await controller.handleMessage(request('READY'));
    expect(messages[0]?.type).toBe('OPENED');
  });

  it('uses READY as a same-document re-handshake after generation changes', async () => {
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });
    const staleReady = request('READY');
    staleReady.generation = 'old-generation';

    await controller.handleMessage(staleReady);

    expect(messages[0]).toMatchObject({
      type: 'OPENED',
      generation: 'generation',
      payload: { snapshot: { generation: 'generation' } },
    });
  });

  it('rejects a stale generation before invoking the session', async () => {
    const messages: ExtensionMessage[] = [];
    const channel: MessageChannel = {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    };
    const controller = new DocumentController(fakeSession(), channel);
    const stale = request('GET_ROWS', { limit: 100 });
    stale.generation = 'old';
    await controller.handleMessage(stale);
    expect(messages[0]).toMatchObject({
      type: 'ERROR',
      payload: { code: 'STALE_GENERATION' },
    });
  });

  it('routes insight work through its own bounded response type', async () => {
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });

    await controller.handleMessage(request('GET_INSIGHTS', { dimension: 'eventKind' }));

    expect(messages[0]).toMatchObject({
      type: 'INSIGHTS',
      payload: { dimension: 'eventKind', processedRecords: '0', examinedRecords: '0' },
    });
  });
});
