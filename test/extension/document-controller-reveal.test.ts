import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentController, type JsonlSessionPort } from '../../src/extension/document-controller';
import { PROTOCOL_VERSION, type DocumentSummary, type ExtensionMessage } from '../../src/shared/types';
import { validateWebviewRequest } from '../../src/extension/message-validation';

const controllers: DocumentController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); });

function fixture() {
  let current = { snapshot: { documentId: 'doc-1', generation: 'g-1', epoch: 1 }, indexedRecords: '100', indexingComplete: true } as DocumentSummary;
  const sent: ExtensionMessage[] = [];
  const controller = new DocumentController({ getSummary: () => current } as JsonlSessionPort,
    { postMessage: async (message) => { sent.push(message); return true; } });
  controllers.push(controller);
  return { controller, sent, change: () => { current = { ...current, snapshot: { ...current.snapshot, epoch: 2 } }; } };
}
const target = { sourceId: 'source-1', nativeId: 'record-42', anchorOrdinal: '42' };
function ack(message: ExtensionMessage, payload: Record<string, unknown> = {}) {
  return { protocolVersion: PROTOCOL_VERSION, type: 'REVEAL_ACK', documentId: message.documentId,
    generation: message.generation, epoch: message.epoch, delivery: 'reply', requestId: message.requestId,
    payload: { anchorOrdinal: '42', outcome: 'shown', renderedOrdinal: '42', ...payload } };
}

describe('correlated internal reveal', () => {
  it('waits for a matching rendered ordinal before settling shown', async () => {
    const { controller, sent } = fixture();
    const result = controller.revealRow(target);
    expect(sent[0]).toMatchObject({ type: 'REVEAL', epoch: 1, payload: target });
    expect(sent[0]).toMatchObject({ delivery: 'request' });
    expect(sent[0]!.requestId).not.toBe('');
    await controller.handleMessage(ack(sent[0]!, { renderedOrdinal: '43' }));
    const settled = vi.fn(); void result.then(settled); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    await controller.handleMessage(ack(sent[0]!));
    await expect(result).resolves.toMatchObject({ outcome: 'shown', documentId: 'doc-1', generation: 'g-1', epoch: 1, anchorOrdinal: '42' });
  });

  it('settles stale after the lifecycle advances even if a ghost ACK repeats the old identity', async () => {
    const { controller, sent, change } = fixture();
    const result = controller.revealRow(target); change();
    await controller.handleMessage(ack(sent[0]!));
    await expect(result).resolves.toMatchObject({ outcome: 'stale' });
  });

  it('does not let a forged epoch or unknown request settle the active reveal', async () => {
    vi.useFakeTimers(); const { controller, sent } = fixture();
    const result = controller.revealRow(target);
    await controller.handleMessage({ ...ack(sent[0]!), epoch: 9 });
    await controller.handleMessage({ ...ack(sent[0]!), requestId: 'unknown' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toMatchObject({ outcome: 'timeout' });
  });

  it('supersedes a prior reveal and ignores its late ACK', async () => {
    const { controller, sent } = fixture();
    const first = controller.revealRow(target);
    const second = controller.revealRow({ ...target, anchorOrdinal: '43' });
    await expect(first).resolves.toMatchObject({ outcome: 'superseded' });
    await controller.handleMessage(ack(sent[0]!));
    await controller.handleMessage(ack(sent[1]!, { anchorOrdinal: '43', renderedOrdinal: '43' }));
    await expect(second).resolves.toMatchObject({ outcome: 'shown', anchorOrdinal: '43' });
  });

  it('cancels pending confirmation when the view closes', async () => {
    const { controller } = fixture(); const result = controller.revealRow(target); controller.dispose();
    await expect(result).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it('rechecks the observed source before accepting shown and fences a slow old check', async () => {
    let finish!: (value: boolean) => void;
    const summary = { snapshot: { documentId: 'doc-1', generation: 'g-1', epoch: 1 }, indexedRecords: '100' } as DocumentSummary;
    const sent: ExtensionMessage[] = [];
    const controller = new DocumentController({ getSummary: () => summary } as JsonlSessionPort,
      { postMessage: async (value) => { sent.push(value); return true; } },
      { validateRevealSource: () => new Promise((resolve) => { finish = resolve; }) });
    controllers.push(controller);
    const first = controller.revealRow(target);
    const oldAck = controller.handleMessage(ack(sent[0]!));
    const second = controller.revealRow(target);
    finish(true); await oldAck;
    await expect(first).resolves.toMatchObject({ outcome: 'superseded' });
    const newAck = controller.handleMessage(ack(sent[1]!)); finish(false); await newAck;
    await expect(second).resolves.toMatchObject({ outcome: 'stale' });
  });

  it('rejects an out of range target before dispatch', async () => {
    const { controller, sent } = fixture();
    await expect(controller.revealRow({ ...target, anchorOrdinal: '100' })).resolves.toMatchObject({ outcome: 'out-of-range' });
    expect(sent).toEqual([]);
  });
  it('does not mistake an unfinished index prefix for the source size', async () => {
    const summary = { snapshot: { documentId: 'doc-1', generation: 'g-1' }, indexedRecords: '0', indexingComplete: false } as DocumentSummary;
    const sent: ExtensionMessage[] = [];
    const controller = new DocumentController({ getSummary: () => summary } as JsonlSessionPort,
      { postMessage: async (value) => { sent.push(value); return true; } });
    controllers.push(controller);
    const result = controller.revealRow(target);
    expect(sent[0]).toMatchObject({ type: 'REVEAL', payload: target });
    controller.dispose();
    await expect(result).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it.each(['01', '-1', '1e2', '9'.repeat(65)])('rejects malformed physical ordinal %s', async (anchorOrdinal) => {
    const { controller, sent } = fixture();
    await expect(controller.revealRow({ ...target, anchorOrdinal })).resolves.toMatchObject({ outcome: 'out-of-range' });
    expect(sent).toEqual([]);
  });
});

describe('reveal ACK boundary', () => {
  const base = { protocolVersion: PROTOCOL_VERSION, type: 'REVEAL_ACK', documentId: 'doc-1', generation: 'g-1', epoch: 1,
    delivery: 'reply', requestId: 'reveal-1', payload: { anchorOrdinal: '42', outcome: 'shown', renderedOrdinal: '42' } };
  it('accepts a bounded exact acknowledgement', () => { expect(validateWebviewRequest(base).ok).toBe(true); });
  it.each([
    { anchorOrdinal: '01' }, { renderedOrdinal: '43' }, { renderedOrdinal: undefined }, { extra: 'not-allowed' },
    { outcome: 'whatever' }, { reason: 'x'.repeat(257) },
  ])('rejects malformed ACK payload %j', (payload) => {
    expect(validateWebviewRequest({ ...base, payload: { ...base.payload, ...payload } }).ok).toBe(false);
  });
});
