import { describe, expect, it } from 'vitest';
import { RecordLineageUiController } from '../../src/webview/features/record-lineage/controller';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';
import { isExtensionMessage } from '../../src/shared/transport';
import { PROTOCOL_VERSION, type ExtensionMessage, type WebviewRequest } from '../../src/shared/types';
import type { LineageLookupReply } from '../../src/shared/lineage-lookup';
import { lineageEvidence as evidence, lineageRow as row, lineageSummary as summary } from '../support/lineage-fixtures';

function fixture() {
  let current = summary(); const sent: WebviewRequest[] = [];
  const source = row(600, { parentId: 'target', evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
  const match = row(200, { messageId: 'target' }); const rows = [source];
  const client = new VsCodeMessageClient({ postMessage: (message) => { sent.push(message); } }, current.snapshot);
  const controller = new RecordLineageUiController({ client, getContext: () => ({ summary: current, rows, available: true }), onChange() {} });
  const payload: LineageLookupReply = { sourceRef: source.ref, relation: 'parent', status: 'found', profileId: current.profileId,
    profileVersion: '3', profileEpoch: 1, match, scope: { kind: 'physical-window', startOrdinal: '100', endOrdinalExclusive: '600',
      examinedRecords: 500, examinedBytes: '1000', requestedBytes: 1200, complete: true } };
  const reply = (requestId = sent.at(-1)?.requestId ?? 'synthetic-reply', value = payload) => ({ protocolVersion: PROTOCOL_VERSION, type: 'LINEAGE_LOOKUP_RESULT',
    documentId: 'doc', generation: 'g', epoch: 1, requestId, payload: value }) as Extract<ExtensionMessage, { type: 'LINEAGE_LOOKUP_RESULT' }>;
  return { controller, client, sent, source, match, payload, reply, changeProfile: () => { current = { ...current, profileEpoch: 2 }; } };
}
describe('Lineage lookup UI correlation', () => {
  it('performs zero IPC before explicit lookup, then merges only the exact bounded match', () => {
    const f = fixture(); expect(f.sent).toHaveLength(0); f.controller.lookup(f.source.ref, 'parent');
    expect(f.sent).toHaveLength(1); expect(f.sent[0]!.type).toBe('LOOKUP_LINEAGE_RECORD');
    const reply = f.reply(); expect(f.client.accept(reply)).toEqual(reply); f.controller.receive(reply);
    expect(f.controller.state.extraRows).toEqual([f.match]);
  });
  it('rejects cancelled and superseded replies at the transport and feature gates', () => {
    const f = fixture(); f.controller.lookup(f.source.ref, 'parent'); const old = f.reply(); f.controller.cancel();
    expect(f.client.accept(old)).toBeUndefined(); f.controller.receive(old); expect(f.controller.state.extraRows).toEqual([]);
    f.controller.lookup(f.source.ref, 'parent'); f.controller.lookup(f.source.ref, 'parent');
    expect(f.sent.filter((message) => message.type === 'CANCEL').length).toBeGreaterThan(0);
    f.controller.receive(old); expect(f.controller.state.status).toBe('loading');
  });
  it('keeps the newest sixteen matches previewable when following a longer chain', () => {
    const f = fixture(); let source = f.source;
    for (let index = 0; index < 17; index += 1) {
      const ordinal = Number(source.ref.ordinal) - 1;
      const match = row(ordinal, { messageId: source.profile!.parentId!, parentId: `next-${index}`,
        evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
      f.controller.lookup(source.ref, 'parent');
      const reply = f.reply(undefined, { ...f.payload, sourceRef: source.ref, match,
        scope: { ...f.payload.scope, startOrdinal: String(ordinal - 499), endOrdinalExclusive: source.ref.ordinal } });
      expect(f.client.accept(reply)).toEqual(reply); f.controller.receive(reply);
      source = match;
    }
    expect(f.controller.state.extraRows).toHaveLength(16);
    expect(f.controller.state.extraRows[0]!.ref.ordinal).toBe('598');
    expect(f.controller.state.extraRows.at(-1)).toEqual(source);
    expect(f.controller.state.reply?.match).toEqual(source);
  });
  it('drops same-generation late profile results and clears old nodes on page replacement', () => {
    const f = fixture(); f.controller.lookup(f.source.ref, 'parent'); const reply = f.reply(); f.changeProfile(); f.controller.receive(reply);
    expect(f.controller.state.extraRows).toEqual([]); expect(f.controller.state.status).toBe('idle');
  });
  it('validates bounds, coordinates and source relation instead of trusting a found status', () => {
    const f = fixture(); expect(isExtensionMessage(f.reply())).toBe(true);
    expect(isExtensionMessage(f.reply('x', { ...f.payload, scope: { ...f.payload.scope, requestedBytes: 1_048_577 } }))).toBe(false);
    for (const scope of [{ ...f.payload.scope, endOrdinalExclusive: '99' }, { ...f.payload.scope, endOrdinalExclusive: '601' },
      { ...f.payload.scope, startOrdinal: '300', examinedRecords: 0 }, { ...f.payload.scope, complete: false }]) {
      expect(isExtensionMessage(f.reply('x', { ...f.payload, scope }))).toBe(false);
    }
    expect(isExtensionMessage(f.reply('x', { ...f.payload, match: { ...f.match, ref: { ...f.match.ref, byteStart: '1' } } }))).toBe(false);
    f.controller.lookup(f.source.ref, 'parent'); f.controller.receive(f.reply(undefined, { ...f.payload, match: row(200, { messageId: 'wrong' }) }));
    expect(f.controller.state.status).toBe('error'); expect(f.controller.state.extraRows).toEqual([]);
  });
});
