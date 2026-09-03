import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { validateWebviewRequest } from '../../src/extension/message-validation';

function envelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    documentId: 'document',
    generation: 'generation',
    requestId: 'request',
    payload,
  };
}

describe('webview message validation', () => {
  it('accepts a bounded rows request', () => {
    const result = validateWebviewRequest(envelope('GET_ROWS', { limit: 100 }));
    expect(result.ok).toBe(true);
  });

  it('rejects an oversized page', () => {
    const result = validateWebviewRequest(envelope('GET_ROWS', { limit: 10_000 }));
    expect(result.ok).toBe(false);
  });

  it('rejects deeply nested query predicates', () => {
    let predicate: unknown = {
      op: 'text_search',
      value: 'needle',
      caseSensitive: false,
    };
    for (let index = 0; index < 20; index += 1) {
      predicate = { op: 'not', arg: predicate };
    }
    const result = validateWebviewRequest(envelope('GET_ROWS', { limit: 100, predicate }));
    expect(result.ok).toBe(false);
  });

  it('accepts bounded insight requests and rejects unknown dimensions', () => {
    expect(validateWebviewRequest(envelope('GET_INSIGHTS', {
      dimension: 'eventKind',
      predicate: { op: 'text_search', value: 'error', caseSensitive: false },
    })).ok).toBe(true);
    expect(validateWebviewRequest(envelope('GET_INSIGHTS', { dimension: 'arbitrary' })).ok).toBe(false);
  });
});
