import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import {
  CancellationRegistry,
  createProtocolEnvelope,
  isExtensionMessage,
  isProtocolEnvelope,
  readProtocolIdentity,
  validateProtocolEnvelope,
} from '../../src/shared/transport';

describe('shared transport boundary', () => {
  it('accepts metadata-only dataset provenance and rejects raw fields', async () => {
    const { isDatasetRuntimeProvenance } = await import('../../src/shared/transport/dataset-provenance');
    const metadata = {
      version: 1, status: 'partial', framing: 'jsonl', adapterId: 'llamafactory-v1', adapterVersion: '1.0.0',
      shape: 'sft', confidence: 'medium', clockBasis: 'record-order',
      samplePlan: { strategy: 'head', maxRecords: 32, maxBytes: 262144 },
      coverage: { sampledRecords: 1, validRecords: 1, invalidRecords: 0, examinedBytes: '12', partial: true, stoppedBy: 'record_limit' },
    };
    expect(isDatasetRuntimeProvenance(metadata)).toBe(true);
    expect(isExtensionMessage(createProtocolEnvelope({
      type: 'OPENED', documentId: 'd', generation: 'g', requestId: '', delivery: 'broadcast', epoch: 1,
      payload: {
        snapshot: { documentId: 'd', generation: 'g', epoch: 1, uri: 'file:///x', scheme: 'file', sizeBytes: '12', mtimeMs: 0, prefixFingerprint: 'fp', observedAt: '2026-01-01T00:00:00Z' },
        profileId: 'generic', profileVersion: '1.0.0', profileEpoch: 1, profileSuggestions: [],
        indexedBytes: '12', indexedRecords: '1', indexingComplete: true, validRecords: '1', problemRecords: '0',
        datasetProvenance: metadata,
      },
    }))).toBe(true);
    expect(isDatasetRuntimeProvenance({ ...metadata, raw: { secret: true } })).toBe(false);
  });

  it('stamps the protocol version and preserves optional lifecycle ordering', () => {
    expect(createProtocolEnvelope({
      type: 'OPENED',
      documentId: 'document',
      generation: 'generation',
      requestId: '',
      delivery: 'broadcast',
      epoch: 3,
      payload: {},
    })).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: 'OPENED',
      documentId: 'document',
      generation: 'generation',
      delivery: 'broadcast',
      epoch: 3,
      requestId: '',
      payload: {},
    });
  });

  it('accepts host broadcasts with an empty correlation id', () => {
    const value = createProtocolEnvelope({
      type: 'SOURCE_INVALIDATED',
      documentId: 'document',
      generation: 'generation',
      requestId: '',
      delivery: 'broadcast',
      payload: { reason: 'append' },
    });

    expect(isProtocolEnvelope(value)).toBe(true);
    expect(validateProtocolEnvelope(value)).toMatchObject({ ok: true });
  });

  it('validates host Navigator visibility broadcasts as a bounded boolean state', () => {
    const message = { protocolVersion: PROTOCOL_VERSION, direction: 'host-to-webview',
      type: 'NAVIGATOR_VISIBILITY', documentId: 'document', generation: 'generation', requestId: '', delivery: 'broadcast',
      payload: { visible: true } };
    expect(isExtensionMessage(message)).toBe(true);
    expect(isExtensionMessage({ ...message, payload: { visible: 'true' } })).toBe(false);
    expect(isExtensionMessage({ ...message, payload: { visible: true, extra: 'ignored' } })).toBe(false);
  });

  it('requires explicit broadcast delivery for an empty response correlation id', () => {
    const message = { protocolVersion: PROTOCOL_VERSION, direction: 'host-to-webview',
      type: 'INDEX_PROGRESS', documentId: 'document', generation: 'generation', requestId: '', payload: {
        snapshot: { documentId: 'document', generation: 'generation', epoch: 1, uri: 'file:///x', scheme: 'file', sizeBytes: '12', mtimeMs: 0, prefixFingerprint: 'fp', observedAt: '2026-01-01T00:00:00Z' },
        profileId: 'generic', profileSuggestions: [], indexedBytes: '12', indexedRecords: '1', indexingComplete: true, validRecords: '1', problemRecords: '0',
      } };

    expect(isExtensionMessage(message)).toBe(false);
    expect(isExtensionMessage({ ...message, delivery: 'broadcast' })).toBe(true);
    expect(isExtensionMessage({ ...message, delivery: 'request' })).toBe(false);
  });

  it('rejects broadcast delivery when a correlation id is present', () => {
    const progress = { protocolVersion: PROTOCOL_VERSION, type: 'INDEX_PROGRESS', documentId: 'document', generation: 'generation',
      requestId: 'correlated', delivery: 'broadcast', payload: {
        snapshot: { documentId: 'document', generation: 'generation', uri: 'file:///x', scheme: 'file', sizeBytes: '0', mtimeMs: 0, prefixFingerprint: 'x', observedAt: 'now' },
        profileId: 'generic', profileSuggestions: [], indexedBytes: '0', indexedRecords: '0', indexingComplete: true, validRecords: '0', problemRecords: '0',
      } };
    expect(validateProtocolEnvelope(progress)).toMatchObject({ ok: false, error: 'Broadcast delivery requires an empty request id.' });
    expect(isExtensionMessage(progress)).toBe(false);
  });

  it('requires empty ids for broadcasts and nonempty ids for explicit request or reply delivery', () => {
    const base = { protocolVersion: PROTOCOL_VERSION, type: 'INDEX_PROGRESS', documentId: 'document', generation: 'generation', payload: {} };
    expect(validateProtocolEnvelope({ ...base, requestId: 'request', delivery: 'broadcast' }))
      .toMatchObject({ ok: false, error: 'Broadcast delivery requires an empty request id.' });
    expect(validateProtocolEnvelope({ ...base, requestId: '', delivery: 'reply' }).ok).toBe(false);
    expect(validateProtocolEnvelope({ ...base, requestId: '', delivery: 'request' }).ok).toBe(false);
    expect(validateProtocolEnvelope({ ...base, requestId: 'legacy-nonempty' }).ok).toBe(true);
  });

  it('rejects unsupported versions and oversized transport identities', () => {
    expect(validateProtocolEnvelope({
      protocolVersion: PROTOCOL_VERSION + 1,
      type: 'READY',
      documentId: 'document',
      generation: 'generation',
      requestId: 'request',
      payload: {},
    })).toEqual({ ok: false, error: 'Unsupported protocol version.' });
    expect(validateProtocolEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      type: 'READY',
      documentId: 'x'.repeat(257),
      generation: 'generation',
      requestId: 'request',
      payload: {},
    })).toEqual({ ok: false, error: 'Document identity is required.' });
  });

  it('extracts a bounded identity from malformed messages without throwing', () => {
    expect(readProtocolIdentity({ documentId: 'document', generation: 1, requestId: '' })).toEqual({
      documentId: 'document',
      generation: 'unknown',
      requestId: '',
    });
    expect(readProtocolIdentity(undefined)).toEqual({
      documentId: 'unknown',
      generation: 'unknown',
      requestId: 'unknown',
    });
    expect(readProtocolIdentity({
      documentId: 'd'.repeat(257),
      generation: 'generation',
      requestId: 'r'.repeat(129),
    })).toEqual({
      documentId: 'unknown',
      generation: 'generation',
      requestId: 'unknown',
    });
  });

  it('cancels request work and removes completed entries', () => {
    const registry = new CancellationRegistry();
    const signal = registry.start('request-1');

    expect(registry.size).toBe(1);
    expect(signal.aborted).toBe(false);
    expect(registry.cancel('request-1')).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.cancel('request-1')).toBe(false);
  });

  it('rejects uncorrelatable cancellation entries', () => {
    const registry = new CancellationRegistry();
    expect(() => registry.start('')).toThrow('Invalid request id');
    expect(() => registry.start('r'.repeat(129))).toThrow('Invalid request id');
  });

  it('keeps the active channel request when startLatest receives an invalid id', () => {
    const registry = new CancellationRegistry();
    const current = registry.startLatest('rows', 'request-1');

    expect(() => registry.startLatest('rows', '')).toThrow('Invalid request id');
    expect(current.aborted).toBe(false);
    expect(registry.size).toBe(1);
    expect(registry.cancel('request-1')).toBe(true);
  });

  it('keeps both channel and prior request when startLatest receives a duplicate id', () => {
    const registry = new CancellationRegistry();
    const current = registry.startLatest('rows', 'request-1');
    const other = registry.startLatest('detail', 'request-2');

    expect(() => registry.startLatest('rows', 'request-2')).toThrow('Duplicate request id');
    expect(current.aborted).toBe(false);
    expect(other.aborted).toBe(false);
    expect(registry.size).toBe(2);
    registry.cancelAll();
  });

  it('keeps only the latest request in a cancellation channel', () => {
    const registry = new CancellationRegistry();
    const first = registry.startLatest('rows', 'request-1');
    const second = registry.startLatest('rows', 'request-2');

    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(registry.size).toBe(1);
    registry.finish('request-2', second);
    expect(registry.size).toBe(0);
  });

  it('finishes only the signal that currently owns the request id', () => {
    const registry = new CancellationRegistry();
    const owner = registry.startLatest('rows', 'request');

    expect(registry.finish('request', new AbortController().signal)).toBe(false);
    expect(registry.size).toBe(1);
    expect(registry.finish('request', owner)).toBe(true);
    expect(registry.finish('request', owner)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('preserves a reused id and its channel after an old signal finishes late', () => {
    const registry = new CancellationRegistry();
    const retired = registry.startLatest('rows', 'reused');
    expect(registry.cancel('reused')).toBe(true);
    const current = registry.startLatest('rows', 'reused');

    expect(registry.finish('reused', retired)).toBe(false);
    expect(registry.size).toBe(1);
    expect(current.aborted).toBe(false);
    const replacement = registry.startLatest('rows', 'next');
    expect(current.aborted).toBe(true);
    expect(registry.finish('next', replacement)).toBe(true);
    expect(registry.size).toBe(0);
  });

  it.each([
    ['OPENED', { profileId: 'generic' }],
    ['ROWS', { rows: [{ genericSummary: 'missing ref', cells: [] }], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '1' }],
    ['DETAIL', { ref: {}, rawPreview: '{}', rawComplete: true, problems: [] }],
    ['INSIGHTS', { dimension: 'eventKind', categories: [], timeBuckets: [], processedRecords: 1, examinedRecords: '1', examinedBytes: '1', truncated: false, capacityReached: false, bucketWidthMs: 1 }],
  ] as const)('rejects malformed %s response payloads before Webview acceptance', (type, payload) => {
    expect(isExtensionMessage(createProtocolEnvelope({
      type,
      documentId: 'document',
      generation: 'generation',
      requestId: 'request',
      payload,
    }))).toBe(false);
  });
});
