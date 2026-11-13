import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegratedJsonlSession } from '../../src/extension/integrated-session/integrated-session';
import { DocumentGraphController } from '../../src/extension/document-graph';
import { DocumentController } from '../../src/extension/document-controller';
import { JsonlFileEngine } from '../../src/engine';
import { PROTOCOL_VERSION, type ExtensionMessage, type RecordRef } from '../../src/shared/types';
import { claudeFixture, codexFixture } from '../profiles/fixtures';

const directories: string[] = []; const sessions: IntegratedJsonlSession[] = []; const controllers: DocumentController[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const controller of controllers.splice(0)) controller.dispose();
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture(records: readonly unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-graph-')); directories.push(directory);
  const path = join(directory, 'synthetic.jsonl'); await writeFile(path, records.map((item) => JSON.stringify(item)).join('\n'));
  const session = await IntegratedJsonlSession.open(path, { uri: 'file:///synthetic.jsonl', backgroundIndexing: false }); sessions.push(session);
  const graph = new DocumentGraphController(session, () => true);
  return { path, session, graph };
}
describe('real session graph and confirmed physical reveal', () => {
  it('retains actual indexed LF/CRLF/no-final-ending content spans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-graph-spans-')); directories.push(directory);
    const path = join(directory, 'synthetic.jsonl'); await writeFile(path, '{}\r\n{}\n{}');
    const session = await IntegratedJsonlSession.open(path, { uri: 'file:///synthetic.jsonl', backgroundIndexing: false, autoDetectProfiles: false }); sessions.push(session);
    const reply = await new DocumentGraphController(session, () => true).load('spans', new AbortController().signal);
    expect(reply.graph.snapshot.nodes.map((node) => node.recordRef)).toMatchObject([
      { byteStart: '0', byteEndExclusive: '2', contentByteLength: '2', delimiterByteLength: 2 },
      { byteStart: '4', byteEndExclusive: '6', contentByteLength: '2', delimiterByteLength: 1 },
      { byteStart: '7', byteEndExclusive: '9', contentByteLength: '2', delimiterByteLength: 0 },
    ]);
  });
  it('uses background engine pages and real indexed refs/profile evidence for Claude and Codex', async () => {
    const background = vi.spyOn(JsonlFileEngine.prototype, 'getObservedBackgroundRows');
    for (const records of [claudeFixture, codexFixture]) {
      const f = await fixture(records); const reply = await f.graph.load('graph', new AbortController().signal);
      expect(background).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, direction: 'forward',
        scanBudget: expect.objectContaining({ maxExaminedRecords: 100, maxExaminedBytes: '4194304' }), projection: { conversation: false, dataset: false } }));
      expect(reply.graph.snapshot.nodes).toHaveLength(records.length);
      expect(reply.graph.snapshot.edges.length).toBeGreaterThan(0);
      const page = await f.session.getRows({ limit: 100 }, new AbortController().signal);
      expect(reply.graph.snapshot.nodes.map((node) => node.recordRef)).toEqual(page.rows.map((row) => row.ref));
      if (records === codexFixture) expect(reply.graph.snapshot.edges.every((edge) => edge.kind === 'responds')).toBe(true);
    }
  });
  it('refuses a source append between graph load and reveal without reading a whole-file hash', async () => {
    const f = await fixture(claudeFixture); const reply = await f.graph.load('graph', new AbortController().signal); f.graph.publish('graph', reply);
    await appendFile(f.path, '\n{}');
    expect(await f.graph.resolve({ graphRequestId: 'graph', ref: reply.graph.snapshot.nodes[0]!.recordRef! })).toBeUndefined();
  });
  it('posts Graph reveal success only after the matching Table DOM acknowledgement', async () => {
    const f = await fixture(claudeFixture); const sent: ExtensionMessage[] = [];
    const controller = new DocumentController(f.session, { postMessage: async (message) => { sent.push(message); return true; } },
      { graph: f.graph, validateRevealSource: () => f.session.validateObservedSource() }); controllers.push(controller);
    const snapshot = f.session.getSummary().snapshot;
    const request = (type: string, requestId: string, payload: unknown) => ({ protocolVersion: PROTOCOL_VERSION, type, requestId,
      documentId: snapshot.documentId, generation: snapshot.generation, epoch: snapshot.epoch, payload });
    await controller.handleMessage(request('GET_GRAPH', 'graph', {}));
    const graph = sent.find((message) => message.type === 'GRAPH'); expect(graph?.type).toBe('GRAPH');
    if (graph?.type !== 'GRAPH') throw new Error('Missing current graph');
    const ref: RecordRef = graph.payload.graph.snapshot.nodes[0]!.recordRef!;
    const pending = controller.handleMessage(request('REVEAL_GRAPH_RECORD', 'open', { graphRequestId: 'graph', ref }));
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'REVEAL')).toBe(true));
    expect(sent.some((message) => message.type === 'GRAPH_REVEAL_RESULT')).toBe(false);
    const reveal = sent.find((message) => message.type === 'REVEAL')!;
    await controller.handleMessage(request('REVEAL_ACK', reveal.requestId, { anchorOrdinal: ref.ordinal, renderedOrdinal: ref.ordinal, outcome: 'shown' }));
    await pending;
    expect(sent.at(-1)).toMatchObject({ type: 'GRAPH_REVEAL_RESULT', requestId: 'open', payload: { graphRequestId: 'graph', ref, outcome: 'shown' } });
  });
});
