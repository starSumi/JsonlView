import { describe, expect, it } from 'vitest';
import { projectRecordLineage } from '../../src/webview/features/record-lineage/model';
import type { AgentRowProjection, RecordRef, RowProjection } from '../../src/shared/types';

function row(ordinal: number, profile?: Partial<AgentRowProjection>): RowProjection {
  return {
    ref: {
      generation: 'g', ordinal: String(ordinal), byteStart: String(ordinal * 3),
      byteEndExclusive: String(ordinal * 3 + 2), contentByteLength: '2', delimiterByteLength: 1, parseState: 'valid',
    },
    cells: [], genericSummary: `row ${ordinal}`,
    ...(profile === undefined ? {} : { profile: {
      profileId: 'claude-code-session', eventKind: 'message', summary: `message ${ordinal}`,
      confidence: 'source', evidence: [], ...profile,
    } }),
  };
}

const evidence = (field: string, ...keys: string[]) => ({ field,
  path: { tokens: keys.map((value) => ({ kind: 'key' as const, value })) } });
const messageEvidence = (messageId = true, parentId = false) => [
  ...(messageId ? [evidence('messageId', 'uuid')] : []),
  ...(parentId ? [evidence('parentId', 'parentUuid')] : []),
];
const refs = (result: ReturnType<typeof projectRecordLineage>) => result.nodes.map((node) => node.ref.ordinal);

describe('record lineage page projection', () => {
  it('projects exact observed parent links around the selected record within the current page', () => {
    const grandparent = row(1, { messageId: 'a', sessionId: 's', turnId: 't', evidence: messageEvidence() });
    const parent = row(2, { messageId: 'b', parentId: 'a', sessionId: 's', turnId: 't', evidence: messageEvidence(true, true) });
    const selected = row(3, { messageId: 'c', parentId: 'b', sessionId: 's', turnId: 't', evidence: messageEvidence(true, true) });
    const unrelated = row(4, { messageId: 'other', sessionId: 's', turnId: 't', evidence: messageEvidence() });

    const result = projectRecordLineage([grandparent, parent, selected, unrelated], selected.ref);

    expect(refs(result)).toEqual(['1', '2', '3']);
    expect(result.nodes.map((node) => node.depth)).toEqual([2, 1, 0]);
    expect(result.edges).toEqual([
      { from: grandparent.ref, to: parent.ref, kind: 'parent' },
      { from: parent.ref, to: selected.ref, kind: 'parent' },
    ]);
    expect(result.coverage).toMatchObject({ scope: 'current-page', status: 'current-page', examinedRows: 4 });
  });

  it('labels siblings and their children as related to the selected record', () => {
    const parent = row(1, { messageId: 'p', sessionId: 's', evidence: messageEvidence() });
    const selected = row(2, { messageId: 'a', parentId: 'p', sessionId: 's', evidence: messageEvidence(true, true) });
    const sibling = row(3, { messageId: 'b', parentId: 'p', sessionId: 's', evidence: messageEvidence(true, true) });
    const nephew = row(4, { parentId: 'b', sessionId: 's', evidence: messageEvidence(false, true) });
    const child = row(5, { parentId: 'a', sessionId: 's', evidence: messageEvidence(false, true) });

    const result = projectRecordLineage([parent, selected, sibling, nephew, child], selected.ref);

    expect(result.nodes.map(({ ref, direction, depth }) => [ref.ordinal, direction, depth])).toEqual([
      ['1', 'ancestor', 1], ['2', 'selected', 0], ['3', 'related', 2], ['4', 'related', 3], ['5', 'descendant', 1],
    ]);
  });

  it('reports duplicate same-context IDs as ambiguous instead of choosing a parent', () => {
    const first = row(1, { messageId: 'dup', sessionId: 's', turnId: 't', evidence: messageEvidence() });
    const second = row(2, { messageId: 'dup', sessionId: 's', turnId: 't', evidence: messageEvidence() });
    const selected = row(3, { parentId: 'dup', sessionId: 's', turnId: 't', evidence: messageEvidence(false, true) });

    const result = projectRecordLineage([first, second, selected], selected.ref);

    expect(result.edges).toEqual([]);
    expect(refs(result)).toEqual(['3']);
    expect(result.coverage).toMatchObject({ status: 'ambiguous', reasons: ['ambiguous-parent'] });

    const selectedDuplicate = projectRecordLineage([first, second, selected], first.ref);
    expect(refs(selectedDuplicate)).toEqual(['1']);
    expect(selectedDuplicate.coverage).toMatchObject({ status: 'ambiguous', reasons: ['ambiguous-parent'] });
  });

  it('never links matching IDs across profile, session, or turn boundaries', () => {
    const otherSession = row(1, { messageId: 'target', sessionId: 'other', turnId: 't', evidence: messageEvidence() });
    const otherTurn = row(2, { messageId: 'target', sessionId: 's', turnId: 'other', evidence: messageEvidence() });
    const otherProfile = row(3, { profileId: 'pi-coding-agent', messageId: 'target', sessionId: 's', turnId: 't',
      evidence: [evidence('messageId', 'id')] });
    const selected = row(4, { parentId: 'target', sessionId: 's', turnId: 't', evidence: messageEvidence(false, true) });

    const result = projectRecordLineage([otherSession, otherTurn, otherProfile, selected], selected.ref);

    expect(result.edges).toEqual([]);
    expect(refs(result)).toEqual(['4']);
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['unmatched-parent'] });
  });

  it.each([
    ['both sides omit session context', undefined, undefined, undefined, undefined],
    ['one side omits session context', 's', 't', undefined, 't'],
    ['one side omits turn context', 's', 't', 's', undefined],
  ])('fails closed when parent context is not established: %s', (_case, parentSession, parentTurn, childSession, childTurn) => {
    const parent = row(1, { messageId: 'parent',
      ...(parentSession === undefined ? {} : { sessionId: parentSession }),
      ...(parentTurn === undefined ? {} : { turnId: parentTurn }), evidence: messageEvidence() });
    const selected = row(2, { parentId: 'parent',
      ...(childSession === undefined ? {} : { sessionId: childSession }),
      ...(childTurn === undefined ? {} : { turnId: childTurn }),
      evidence: messageEvidence(false, true) });

    const result = projectRecordLineage([parent, selected], selected.ref);

    expect(result.edges).toEqual([]);
    expect(refs(result)).toEqual(['2']);
    expect(result.coverage).toMatchObject({ status: 'partial' });
    expect(result.coverage.reasons).toContain('missing-parent-context');
  });

  it('marks projected parent IDs without exact source evidence as partial', () => {
    const selected = row(1, { parentId: 'maybe-parent', sessionId: 's', turnId: 't',
      evidence: [evidence('parentId', 'nested', 'parent')] });

    const result = projectRecordLineage([selected], selected.ref);

    expect(refs(result)).toEqual(['1']);
    expect(result.edges).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['unverified-parent-evidence'] });
  });

  it('reports unsupported child evidence even when its candidate parent is selected', () => {
    const parent = row(1, { messageId: 'parent', sessionId: 's', turnId: 't', evidence: messageEvidence() });
    const child = row(2, { parentId: 'parent', sessionId: 's', turnId: 't',
      evidence: [evidence('parentId', 'nested', 'parent')] });

    const result = projectRecordLineage([parent, child], parent.ref);

    expect(refs(result)).toEqual(['1']);
    expect(result.edges).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'partial' });
    expect(result.coverage.reasons).toContain('unverified-parent-evidence');
  });

  it('uses Pi id and parentId only with exact source evidence', () => {
    const parent = row(1, { profileId: 'pi-coding-agent', messageId: 'parent', sessionId: 's', turnId: 't',
      evidence: [evidence('messageId', 'id')] });
    const selected = row(2, { profileId: 'pi-coding-agent', parentId: 'parent', sessionId: 's', turnId: 't',
      evidence: [evidence('parentId', 'parentId')] });

    const result = projectRecordLineage([parent, selected], selected.ref);

    expect(refs(result)).toEqual(['1', '2']);
    expect(result.edges).toEqual([{ from: parent.ref, to: selected.ref, kind: 'parent' }]);
    expect(result.coverage.status).toBe('current-page');
  });

  it('does not infer a Pi session for messages that omit session context', () => {
    const parent = row(1, { profileId: 'pi-coding-agent', messageId: 'parent', evidence: [evidence('messageId', 'id')] });
    const selected = row(2, { profileId: 'pi-coding-agent', parentId: 'parent', evidence: [evidence('parentId', 'parentId')] });

    const result = projectRecordLineage([parent, selected], selected.ref);

    expect(result.edges).toEqual([]);
    expect(refs(result)).toEqual(['2']);
    expect(result.coverage.status).toBe('partial');
    expect(result.coverage.reasons).toContain('missing-parent-context');
  });

  it('projects exact Codex call/result evidence as a related pair', () => {
    const call = row(1, { profileId: 'codex-rollout', eventKind: 'tool_call', toolCallId: 'call-1', sessionId: 's', turnId: 't',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });
    const resultRow = row(2, { profileId: 'codex-rollout', eventKind: 'tool_result', toolCallId: 'call-1', sessionId: 's', turnId: 't',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });

    const result = projectRecordLineage([call, resultRow], call.ref);

    expect(refs(result)).toEqual(['1', '2']);
    expect(result.nodes.map((node) => node.direction)).toEqual(['selected', 'related']);
    expect(result.edges).toEqual([{ from: call.ref, to: resultRow.ref, kind: 'responds' }]);
    expect(result.coverage.status).toBe('current-page');
  });

  it.each([
    ['both sides omit session and turn context', {}, {}],
    ['one side omits session context', { sessionId: 's', turnId: 't' }, { turnId: 't' }],
    ['one side omits turn context', { sessionId: 's', turnId: 't' }, { sessionId: 's' }],
  ])('fails closed when Codex pair context is not established: %s', (_case, callContext, resultContext) => {
    const call = row(1, { profileId: 'codex-rollout', eventKind: 'tool_call', toolCallId: 'call-1',
      ...callContext, evidence: [evidence('toolCallId', 'payload', 'call_id')] });
    const resultRow = row(2, { profileId: 'codex-rollout', eventKind: 'tool_result', toolCallId: 'call-1',
      ...resultContext, evidence: [evidence('toolCallId', 'payload', 'call_id')] });

    const result = projectRecordLineage([call, resultRow], call.ref);

    expect(result.edges).toEqual([]);
    expect(refs(result)).toEqual(['1']);
    expect(result.coverage).toMatchObject({ status: 'partial' });
    expect(result.coverage.reasons).toContain('missing-tool-context');
  });

  it('scopes repeated Codex call IDs to distinct turns', () => {
    const callA = row(1, { profileId: 'codex-rollout', eventKind: 'tool_call', toolCallId: 'call-1', sessionId: 's', turnId: 't1',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });
    const callB = row(2, { profileId: 'codex-rollout', eventKind: 'tool_call', toolCallId: 'call-1', sessionId: 's', turnId: 't2',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });
    const resultB = row(3, { profileId: 'codex-rollout', eventKind: 'tool_result', toolCallId: 'call-1', sessionId: 's', turnId: 't2',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });

    const result = projectRecordLineage([callA, callB, resultB], callB.ref);

    expect(result.edges).toEqual([{ from: callB.ref, to: resultB.ref, kind: 'responds' }]);
    expect(refs(result)).toEqual(['2', '3']);
    expect(result.coverage.status).toBe('current-page');
  });

  it('does not choose among duplicate Codex calls for one result', () => {
    const callA = row(1, { profileId: 'codex-rollout', eventKind: 'tool_call', toolCallId: 'call-1', sessionId: 's', turnId: 't',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });
    const callB = row(2, { profileId: 'codex-rollout', eventKind: 'tool_call', toolCallId: 'call-1', sessionId: 's', turnId: 't',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });
    const resultRow = row(3, { profileId: 'codex-rollout', eventKind: 'tool_result', toolCallId: 'call-1', sessionId: 's', turnId: 't',
      evidence: [evidence('toolCallId', 'payload', 'call_id')] });

    const result = projectRecordLineage([callA, callB, resultRow], resultRow.ref);

    expect(result.edges).toEqual([]);
    expect(refs(result)).toEqual(['3']);
    expect(result.coverage).toMatchObject({ status: 'ambiguous', reasons: ['ambiguous-tool-pair'] });
  });

  it('marks Codex tool IDs without exact source evidence as partial', () => {
    const selected = row(1, { profileId: 'codex-rollout', eventKind: 'tool_result', toolCallId: 'call-1',
      sessionId: 's', turnId: 't', evidence: [evidence('toolCallId', 'call_id')] });

    const result = projectRecordLineage([selected], selected.ref);

    expect(refs(result)).toEqual(['1']);
    expect(result.edges).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['unverified-tool-evidence'] });
  });

  it('does not link same IDs across source generations', () => {
    const parent = row(1, { messageId: 'target', sessionId: 's', turnId: 't', evidence: messageEvidence() });
    const selected = row(2, { parentId: 'target', sessionId: 's', turnId: 't', evidence: messageEvidence(false, true) });
    parent.ref.generation = 'old';

    const result = projectRecordLineage([parent, selected], selected.ref);

    expect(refs(result)).toEqual(['2']);
    expect(result.edges).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['unmatched-parent'] });
  });

  it('marks unresolved and out-of-page parents as partial current-page coverage', () => {
    const selected = row(5, { parentId: 'outside', sessionId: 's', turnId: 't', evidence: messageEvidence(false, true) });

    const result = projectRecordLineage([selected], selected.ref);

    expect(result.edges).toEqual([]);
    expect(result.coverage).toMatchObject({
      scope: 'current-page', status: 'partial',
      reasons: ['unmatched-parent'],
    });
  });

  it.each([false, true])('excludes duplicate physical references from nodes and edges (conflicting profiles: %s)', (conflicting) => {
    const parent = row(1, { messageId: 'p', sessionId: 's', evidence: messageEvidence() });
    const child = row(2, { parentId: 'p', sessionId: 's', evidence: messageEvidence(false, true) });
    const duplicate = { ...child, ...(conflicting ? { profile: { ...child.profile!, sessionId: 'different' } } : {}) };

    const result = projectRecordLineage([parent, child, duplicate], parent.ref);

    expect(refs(result)).toEqual(['1']);
    expect(result.edges).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'ambiguous', reasons: ['ambiguous-record-ref'] });
    expect(projectRecordLineage([parent, child, duplicate], child.ref)).toMatchObject({
      nodes: [], edges: [], coverage: { status: 'ambiguous', reasons: ['ambiguous-selection'] },
    });
  });

  it('requires an exact full RecordRef when locating the selected record', () => {
    const selected = row(7);
    const nearMiss = { ...selected.ref, byteStart: '999' } satisfies RecordRef;

    const result = projectRecordLineage([selected], nearMiss);

    expect(result.nodes).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'missing', reasons: ['selected-not-in-page'] });
  });

  it('limits traversal to three hops and marks omitted deeper relations', () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(index + 1, {
      messageId: `m${index}`, ...(index > 0 ? { parentId: `m${index - 1}` } : {}), sessionId: 's', turnId: 't',
      evidence: messageEvidence(true, index > 0),
    }));

    const result = projectRecordLineage(rows, rows[0]!.ref);

    expect(refs(result)).toEqual(['1', '2', '3', '4']);
    expect(result.nodes.every((node) => node.depth <= 3)).toBe(true);
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['depth-limit'] });
  });

  it('limits the projection to fifteen nodes and marks omitted page neighbors', () => {
    const selected = row(1, { messageId: 'root', sessionId: 's', turnId: 't', evidence: messageEvidence() });
    const children = Array.from({ length: 20 }, (_, index) => row(index + 2, {
      parentId: 'root', sessionId: 's', turnId: 't', evidence: messageEvidence(false, true),
    }));

    const result = projectRecordLineage([selected, ...children], selected.ref);

    expect(result.nodes).toHaveLength(15);
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['node-limit'] });
  });
});
