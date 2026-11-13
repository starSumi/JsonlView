import { describe, expect, it, vi } from 'vitest';
import { DocumentController } from '../../src/extension/document-controller';
import { DocumentLineageAuthority } from '../../src/extension/document-lineage';
import type { IJsonlSessionPort } from '../../src/application/ports/session';
import type { ExtensionMessage } from '../../src/shared/types';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import type { LineageLookupReply } from '../../src/shared/lineage-lookup';
import { validateWebviewRequest } from '../../src/extension/message-validation';
import { lineageEvidence as evidence, lineagePage as page, lineageRow as row, lineageSummary as summary } from '../support/lineage-fixtures';

function fixture() {
  let current = summary(); const source = row(600, { parentId: 'target', evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
  const match = row(200, { messageId: 'target' });
  const reply = (): LineageLookupReply => ({ sourceRef: source.ref, relation: 'parent', status: 'found', profileId: current.profileId,
    profileVersion: current.profileVersion!, profileEpoch: current.profileEpoch!, match,
    scope: { kind: 'physical-window', startOrdinal: '100', endOrdinalExclusive: '600', examinedRecords: 500, examinedBytes: '10000', requestedBytes: 12000, complete: true } });
  const lookup = vi.fn<NonNullable<IJsonlSessionPort['lookupLineage']>>(async () => reply());
  const session = { getSummary: () => current, getRows: async () => page([source]), lookupLineage: lookup } as unknown as IJsonlSessionPort;
  return { source, match, reply, lookup, session, changeProfile: () => { current = { ...current, profileEpoch: 2 }; } };
}
function request(type: string, payload: unknown, requestId = type) {
  return { protocolVersion: PROTOCOL_VERSION, documentId: 'doc', generation: 'g', epoch: 1, type, payload, requestId };
}
describe('Host-issued lineage reference authority and lifecycle', () => {
  it('requires a delivered exact reference and never accepts a client lookup needle, offset, path or budget', async () => {
    const f = fixture(); const authority = new DocumentLineageAuthority(f.session);
    await expect(authority.lookup({ sourceRef: f.source.ref, relation: 'parent' }, new AbortController().signal)).rejects.toThrow('delivered page');
    authority.acceptPage(f.session.getSummary(), [f.source]);
    await expect(authority.lookup({ sourceRef: { ...f.source.ref, byteStart: '1' }, relation: 'parent' }, new AbortController().signal)).rejects.toThrow();
    expect(f.lookup).not.toHaveBeenCalled();
    expect(validateWebviewRequest(request('LOOKUP_LINEAGE_RECORD', { sourceRef: f.source.ref, relation: 'parent' })).ok).toBe(true);
    for (const field of ['targetKey', 'filePath', 'maxBytes', 'byteOffset']) {
      expect(validateWebviewRequest(request('LOOKUP_LINEAGE_RECORD', { sourceRef: f.source.ref, relation: 'parent', [field]: 'untrusted' })).ok).toBe(false);
    }
  });
  it('revokes a settled lookup after a same-generation profile change or page replacement', async () => {
    const f = fixture(); const authority = new DocumentLineageAuthority(f.session); authority.acceptPage(f.session.getSummary(), [f.source]);
    const result = await authority.lookup({ sourceRef: f.source.ref, relation: 'parent' }, new AbortController().signal);
    expect(result.isCurrent()).toBe(true); f.changeProfile(); expect(result.isCurrent()).toBe(false);
    authority.acceptPage(f.session.getSummary(), [f.source]);
    const next = await authority.lookup({ sourceRef: f.source.ref, relation: 'parent' }, new AbortController().signal);
    authority.invalidate(); expect(next.isCurrent()).toBe(false);
  });
  it('retains at most sixteen lookup references even when the accepted page is small', async () => {
    const f = fixture(); const authority = new DocumentLineageAuthority(f.session);
    authority.acceptPage(f.session.getSummary(), [f.source]);
    const matches = []; let source = f.source;
    for (let index = 0; index < 17; index += 1) {
      const ordinal = Number(source.ref.ordinal) - 1;
      const match = row(ordinal, { messageId: source.profile!.parentId!, parentId: `next-${index}`,
        evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
      f.lookup.mockResolvedValueOnce({ ...f.reply(), sourceRef: source.ref, match,
        scope: { ...f.reply().scope, startOrdinal: String(ordinal - 499), endOrdinalExclusive: source.ref.ordinal } });
      const result = await authority.lookup({ sourceRef: source.ref, relation: 'parent' }, new AbortController().signal);
      result.publish(); matches.push(match); source = match;
    }
    await expect(authority.lookup({ sourceRef: matches[0]!.ref, relation: 'parent' }, new AbortController().signal)).rejects.toThrow('delivered page');
    await expect(authority.lookup({ sourceRef: source.ref, relation: 'parent' }, new AbortController().signal)).rejects.toThrow('invalid source relationship');
    expect(f.lookup).toHaveBeenCalledTimes(18);
  });
  it('rejects malformed completion, foreign profile receipts and relocated windows before granting a result', async () => {
    const f = fixture(); const authority = new DocumentLineageAuthority(f.session); authority.acceptPage(f.session.getSummary(), [f.source]);
    const { match: _match, ...missingMatch } = f.reply();
    for (const reply of [missingMatch, { ...f.reply(), profileVersion: 'old' },
      { ...f.reply(), scope: { ...f.reply().scope, startOrdinal: '0', endOrdinalExclusive: '500' } }]) {
      f.lookup.mockResolvedValueOnce(reply);
      await expect(authority.lookup({ sourceRef: f.source.ref, relation: 'parent' }, new AbortController().signal)).rejects.toThrow('invalid source relationship');
    }
  });
  it('does not issue lookup authority from a rejected page post, and only publishes the latest noncancelled reply', async () => {
    const f = fixture(); const messages: ExtensionMessage[] = []; let deliver = false;
    const controller = new DocumentController(f.session, { postMessage: async (message) => { messages.push(message); return deliver; } });
    await controller.handleMessage(request('GET_ROWS', { limit: 20 }, 'page-1'));
    await controller.handleMessage(request('LOOKUP_LINEAGE_RECORD', { sourceRef: f.source.ref, relation: 'parent' }, 'lookup-1'));
    expect(f.lookup).not.toHaveBeenCalled();
    deliver = true; await controller.handleMessage(request('GET_ROWS', { limit: 20 }, 'page-2'));
    expect(messages.filter((message) => message.requestId === 'page-2')).toMatchObject([{ type: 'ROWS' }]);
    let settle!: (value: LineageLookupReply) => void; let signal: AbortSignal | undefined;
    f.lookup.mockImplementationOnce((_source, _relation, incoming) => { signal = incoming; return new Promise((resolve) => { settle = resolve; }); });
    const first = controller.handleMessage(request('LOOKUP_LINEAGE_RECORD', { sourceRef: f.source.ref, relation: 'parent' }, 'lookup-2'));
    await Promise.resolve();
    await controller.handleMessage(request('LOOKUP_LINEAGE_RECORD', { sourceRef: f.source.ref, relation: 'parent' }, 'lookup-3'));
    expect(signal?.aborted).toBe(true); settle(f.reply()); await first;
    const replies = messages.filter((message) => message.type === 'LINEAGE_LOOKUP_RESULT');
    expect(replies.map((message) => message.requestId)).toEqual(['lookup-3']); controller.dispose();
  });
  it('honors cancellation across an old epoch and suppresses errors from the cancelled operation', async () => {
    const f = fixture(); const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(f.session, { postMessage: async (message) => { messages.push(message); return true; } });
    await controller.handleMessage(request('GET_ROWS', { limit: 20 }));
    expect(messages).toMatchObject([{ type: 'ROWS' }]);
    let reject!: (error: Error) => void; let signal: AbortSignal | undefined;
    f.lookup.mockImplementationOnce((_source, _relation, incoming) => { signal = incoming; return new Promise((_resolve, no) => { reject = no; }); });
    const task = controller.handleMessage(request('LOOKUP_LINEAGE_RECORD', { sourceRef: f.source.ref, relation: 'parent' }, 'lookup'));
    await Promise.resolve();
    await controller.handleMessage({ ...request('CANCEL', { targetRequestId: 'lookup' }), epoch: 0, generation: 'old' });
    expect(signal?.aborted).toBe(true); reject(new Error('cancelled')); await task;
    expect(messages.some((message) => message.requestId === 'lookup')).toBe(false); controller.dispose();
  });
});
