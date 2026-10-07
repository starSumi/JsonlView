import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ExtensionMessage } from '../../src/shared/types';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';

function reveal(generation = 'g-1'): ExtensionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'REVEAL',
    documentId: 'doc-1',
    generation,
    requestId: '',
    payload: { sourceId: 'codex-source', generation, nativeId: 'event-1', anchorOrdinal: '42' },
  };
}

describe('navigator reveal protocol', () => {
  it('accepts an unsolicited reveal only for the current generation', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, { documentId: 'doc-1', generation: 'g-1' });
    expect(client.accept(reveal())).toEqual(reveal());
    expect(client.accept(reveal('g-0'))).toBeUndefined();
  });

  it('rejects a reveal carrying a mismatched payload generation', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, { documentId: 'doc-1', generation: 'g-1' });
    const value = reveal() as Extract<ExtensionMessage, { type: 'REVEAL' }>;
    value.payload.generation = 'g-0';
    expect(client.accept(value)).toBeUndefined();
  });
});
