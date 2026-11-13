import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ExtensionMessage } from '../../src/shared/types';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';

function reveal(generation = 'g-1'): ExtensionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'REVEAL',
    documentId: 'doc-1',
    generation,
    delivery: 'request',
    requestId: 'reveal-1',
    payload: { sourceId: 'codex-source', generation, nativeId: 'event-1', anchorOrdinal: '42' },
  };
}

describe('navigator reveal protocol', () => {
  it('accepts a correlated host reveal only for the current generation', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, { documentId: 'doc-1', generation: 'g-1' });
    expect(client.accept(reveal())).toEqual(reveal());
    expect(client.accept(reveal('g-0'))).toBeUndefined();
  });

  it('rejects broadcasts and noncanonical ordinals', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, { documentId: 'doc-1', generation: 'g-1' });
    expect(client.accept({ ...reveal(), requestId: '' })).toBeUndefined();
    const value = reveal() as Extract<ExtensionMessage, { type: 'REVEAL' }>;
    expect(client.accept({ ...value, payload: { ...value.payload, anchorOrdinal: '01' } })).toBeUndefined();
  });

  it('echoes the accepted identity without adding an ACK to the pending request map', () => {
    const outbound: unknown[] = [];
    const client = new VsCodeMessageClient({ postMessage: (value) => { outbound.push(value); } }, { documentId: 'doc-1', generation: 'g-1', epoch: 3 });
    const message = { ...reveal(), epoch: 3 } as Extract<ExtensionMessage, { type: 'REVEAL' }>;
    expect(client.accept(message)).toEqual(message);
    client.acknowledgeReveal(message, { anchorOrdinal: '42', renderedOrdinal: '42', outcome: 'shown' });
    expect(outbound).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'REVEAL_ACK', documentId: 'doc-1', generation: 'g-1', epoch: 3,
      delivery: 'reply', requestId: 'reveal-1', payload: { anchorOrdinal: '42', renderedOrdinal: '42', outcome: 'shown' } }]);
    expect(client.hasPending('ready')).toBe(false);
    client.setSession({ documentId: 'doc-1', generation: 'g-2', epoch: 4 });
    client.acknowledgeReveal(message, { anchorOrdinal: '42', renderedOrdinal: '42', outcome: 'shown' });
    expect(outbound).toHaveLength(1);
  });

  it('rejects a reveal carrying a mismatched payload generation', () => {
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, { documentId: 'doc-1', generation: 'g-1' });
    const value = reveal() as Extract<ExtensionMessage, { type: 'REVEAL' }>;
    value.payload.generation = 'g-0';
    expect(client.accept(value)).toBeUndefined();
  });
});
