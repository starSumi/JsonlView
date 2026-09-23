import { describe, expect, it } from 'vitest';
import type { DocumentSummary, ExtensionMessage, WebviewRequest } from '../../src/shared/types';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { isExtensionMessage, VsCodeMessageClient, shouldAcceptMessage } from '../../src/webview/protocol-client';

const summary: DocumentSummary = {
  snapshot: {
    documentId: 'doc',
    generation: 'g2',
    uri: 'file:///events.jsonl',
    scheme: 'file',
    sizeBytes: '100',
    mtimeMs: 1,
    prefixFingerprint: 'abc',
    observedAt: '2026-08-30T00:00:00Z',
  },
  profileId: 'generic',
  profileSuggestions: [],
  indexedBytes: '100',
  indexedRecords: '1',
  indexingComplete: true,
  validRecords: '1',
  problemRecords: '0',
};

function message<T extends ExtensionMessage['type']>(
  type: T,
  requestId: string,
  generation: string,
  payload: Extract<ExtensionMessage, { type: T }>['payload'],
): Extract<ExtensionMessage, { type: T }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    documentId: 'doc',
    generation,
    requestId,
    payload,
  } as Extract<ExtensionMessage, { type: T }>;
}

describe('VS Code message client', () => {
  it('accepts the correlated OPENED message and advances the session', () => {
    const sent: WebviewRequest[] = [];
    const client = new VsCodeMessageClient({ postMessage: (value) => sent.push(value) }, {
      documentId: 'bootstrap',
      generation: 'bootstrap',
    });
    const request = client.send('READY', {});
    const opened = message('OPENED', request.id, 'g2', summary);

    expect(client.accept(opened)).toBe(opened);
    expect(client.session).toEqual({ documentId: 'doc', generation: 'g2' });
    expect(sent[0]?.type).toBe('READY');
  });

  it('rejects a correlated OPENED message whose snapshot identity is inconsistent', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'bootstrap',
      generation: 'bootstrap',
    });
    const request = client.send('READY', {});
    const inconsistent = {
      ...message('OPENED', request.id, 'g2', summary),
      payload: {
        ...summary,
        snapshot: { ...summary.snapshot, generation: 'g1' },
      },
    };

    expect(client.accept(inconsistent)).toBeUndefined();
    expect(client.session).toEqual({ documentId: 'bootstrap', generation: 'bootstrap' });
    expect(client.hasPending('ready')).toBe(true);
  });

  it('rejects stale generations and uncorrelated row pages', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g2',
    });
    const request = client.send('GET_ROWS', { limit: 100 });
    const payload = {
      rows: [],
      columns: [],
      anchorOrdinal: '0',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '0',
    };

    expect(client.accept(message('ROWS', request.id, 'g1', payload))).toBeUndefined();
    expect(client.accept(message('ROWS', 'unknown', 'g2', payload))).toBeUndefined();
    expect(client.accept(message('ROWS', request.id, 'g2', payload))?.type).toBe('ROWS');
  });

  it('does not allow one request kind to authorize another response kind', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g2',
    });
    const rows = client.send('GET_ROWS', { limit: 100 });
    const detail = {
      ref: {
        generation: 'g2', ordinal: '1', byteStart: '0', byteEndExclusive: '2',
        contentByteLength: '1', delimiterByteLength: 1 as const, parseState: 'valid' as const,
      },
      rawPreview: '{}',
      rawComplete: true,
      problems: [],
    };

    expect(client.accept(message('DETAIL', rows.id, 'g2', detail))).toBeUndefined();
    expect(client.hasPending('rows')).toBe(true);
  });

  it('cancels the prior request of a given kind with its request id', () => {
    const sent: WebviewRequest[] = [];
    const client = new VsCodeMessageClient({ postMessage: (value) => sent.push(value) }, {
      documentId: 'doc',
      generation: 'g2',
    });
    const rows = client.send('GET_ROWS', { limit: 100 });
    client.send('GET_SCHEMA', { offset: 0, limit: 100 });

    expect(client.cancel('rows')).toEqual([rows.id]);
    expect(sent.at(-1)).toMatchObject({
      type: 'CANCEL',
      payload: { targetRequestId: rows.id },
    });
  });

  it('accepts unsolicited progress only for the active generation', () => {
    const active = message('INDEX_PROGRESS', '', 'g2', summary);
    const stale = message('INDEX_PROGRESS', '', 'g1', {
      ...summary,
      snapshot: { ...summary.snapshot, generation: 'g1' },
    });
    expect(shouldAcceptMessage(active, { documentId: 'doc', generation: 'g2' }, new Map())).toBe(true);
    expect(shouldAcceptMessage(stale, { documentId: 'doc', generation: 'g2' }, new Map())).toBe(false);
  });

  it('completes a follow request when its correlated progress arrives', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g2',
    });
    const request = client.send('SET_FOLLOW_MODE', { enabled: true });

    expect(client.hasPending('follow')).toBe(true);
    expect(client.accept(message('INDEX_PROGRESS', request.id, 'g2', summary))?.type).toBe('INDEX_PROGRESS');
    expect(client.hasPending('follow')).toBe(false);
  });

  it('accepts an unsolicited same-document OPENED after follow advances generation', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g1',
    });
    const opened = message('OPENED', '', 'g2', summary);

    expect(client.accept(opened)).toBe(opened);
    expect(client.session).toEqual({ documentId: 'doc', generation: 'g2' });

    const otherDocument = { ...opened, documentId: 'other', generation: 'g3' };
    expect(client.accept(otherDocument)).toBeUndefined();
  });

  it('rejects a late OPENED for a generation that was already retired', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g1',
    });
    const first = message('OPENED', '', 'g2', summary);
    expect(client.accept(first)).toBe(first);

    const late = message('OPENED', '', 'g1', {
      ...summary,
      snapshot: { ...summary.snapshot, generation: 'g1' },
    });
    expect(client.accept(late)).toBeUndefined();
    expect(client.session).toEqual({ documentId: 'doc', generation: 'g2' });
  });

  it('rejects an unseen older same-document OPENED when epoch ordering is available', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g2',
      epoch: 2,
    });
    const older = {
      ...message('OPENED', '', 'g1', {
        ...summary,
        snapshot: { ...summary.snapshot, generation: 'g1', epoch: 1 },
      }),
      epoch: 1,
    };

    expect(client.accept(older)).toBeUndefined();
    expect(client.session).toEqual({ documentId: 'doc', generation: 'g2', epoch: 2 });
  });

  it('accepts a newer same-document OPENED and advances the epoch', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g1',
      epoch: 1,
    });
    const newer = {
      ...message('OPENED', '', 'g2', {
        ...summary,
        snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2 },
      }),
      epoch: 2,
    };

    expect(client.accept(newer)).toBe(newer);
    expect(client.session).toEqual({ documentId: 'doc', generation: 'g2', epoch: 2 });
  });

  it('rejects an unsolicited OPENED message whose envelope disagrees with its snapshot', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g1',
    });
    const inconsistent = {
      ...message('OPENED', '', 'g2', summary),
      documentId: 'doc',
      generation: 'g3',
    };

    expect(client.accept(inconsistent)).toBeUndefined();
    expect(client.session).toEqual({ documentId: 'doc', generation: 'g1' });
  });

  it('rejects an OPENED message whose envelope epoch disagrees with its snapshot', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g1',
      epoch: 1,
    });
    const inconsistent = {
      ...message('OPENED', '', 'g2', {
        ...summary,
        snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2 },
      }),
      epoch: 3,
    };

    expect(client.accept(inconsistent)).toBeUndefined();
    expect(client.session).toEqual({ documentId: 'doc', generation: 'g1', epoch: 1 });
  });

  it('clears pending work when an accepted session epoch changes', () => {
    const sent: WebviewRequest[] = [];
    const client = new VsCodeMessageClient({ postMessage: (value) => sent.push(value) }, {
      documentId: 'doc',
      generation: 'g1',
      epoch: 1,
    });
    client.send('GET_ROWS', { limit: 100 });
    client.setSession({ documentId: 'doc', generation: 'g1', epoch: 2 });

    expect(client.hasPending('rows')).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('rejects unknown extension message types', () => {
    expect(isExtensionMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'EXECUTE_SOURCE',
      documentId: 'doc',
      generation: 'g2',
      requestId: '',
      payload: {},
    })).toBe(false);
  });

  it('accepts only the correlated insight response', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g2',
    });
    const request = client.send('GET_INSIGHTS', { dimension: 'eventKind' });
    const payload = {
      dimension: 'eventKind' as const,
      categories: [{ label: 'message', count: 2 }],
      timeBuckets: [],
      processedRecords: '2',
      examinedRecords: '4',
      examinedBytes: '256',
      truncated: false,
      capacityReached: false,
      bucketWidthMs: 300_000,
    };

    expect(client.accept(message('INSIGHTS', 'unknown', 'g2', payload))).toBeUndefined();
    expect(client.accept(message('INSIGHTS', request.id, 'g2', payload))?.type).toBe('INSIGHTS');
    expect(client.hasPending('insights')).toBe(false);
  });

  it('accepts a correlated bounded problem page and completes its request', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, {
      documentId: 'doc',
      generation: 'g2',
    });
    const request = client.send('GET_PROBLEMS', { limit: 20 });
    const payload = {
      items: [{ code: 'BLANK_RECORD', message: 'blank', severity: 'warning' as const }],
      anchorOrdinal: '4',
      hasBefore: false,
      hasAfter: true,
      indexedRecords: '5',
      observedProblemRecords: '1',
      complete: false,
      scan: { examinedRecords: '5', examinedBytes: '20', cursorOrdinal: '4', direction: 'forward' as const, truncatedReason: 'byte_limit' as const },
    };

    expect(client.accept(message('PROBLEMS', request.id, 'g2', payload))?.type).toBe('PROBLEMS');
    expect(client.hasPending('problems')).toBe(false);
  });
});
