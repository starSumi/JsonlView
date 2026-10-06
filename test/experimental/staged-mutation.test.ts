import { describe, expect, it } from 'vitest';
import {
  StagedMutationError,
  StagedMutationSession,
  editFor,
  sha256,
  type BaseEdit,
  type KnownDigest,
  type StageIntent,
} from '../../experimental/staged-mutation/index';

const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'utf8'));

function makeSession(text = '{"event":"one"}\r\n{"event":"two"}\r\n'): StagedMutationSession {
  return StagedMutationSession.fromBytes(bytes(text), {
    documentId: 'doc-synthetic',
    sourceIdentity: 'synthetic://phase-2',
    sourceGeneration: 'source-7',
    baseGeneration: 'base-3',
    fenceToken: 'fence-test',
  });
}

function intent(
  session: StagedMutationSession,
  editRanges: readonly BaseEdit[],
  overrides: Partial<StageIntent> = {},
): StageIntent {
  return {
    operationId: 'op-1',
    idempotencyKey: 'idem-1',
    documentId: session.metadata.documentId,
    sourceIdentity: session.metadata.sourceIdentity,
    sourceGeneration: session.metadata.sourceGeneration,
    baseGeneration: session.metadata.baseGeneration,
    baseDigest: session.metadata.baseDigest as KnownDigest,
    editRanges,
    actor: 'synthetic-test',
    capability: 'stage_patch',
    fenceToken: session.fenceToken,
    ...overrides,
  };
}

async function expectCode(action: () => Promise<unknown>, code: StagedMutationError['code']): Promise<void> {
  await expect(action()).rejects.toMatchObject({ code });
}

describe('phase 2 staged mutation experiment', () => {
  it('stages ordered base-byte deltas and keeps CRLF bytes exact', async () => {
    const session = makeSession();
    const source = session.baseBytes;
    const replacementStart = BigInt(Buffer.from('{"event":"', 'utf8').byteLength);
    const replacementEnd = replacementStart + 3n;
    const receipt = await session.stage(intent(session, [
      editFor(source, replacementStart, replacementEnd, bytes('three')),
    ]));

    expect(receipt.sourceUnchanged).toBe(true);
    expect(receipt.stagingGeneration).toBe('1');
    expect(receipt.sourceIdentity).toBe('synthetic://phase-2');
    expect(session.metadata.newline).toBe('crlf');
    const copy = await session.simulateExportCopy({ operationId: 'export-crlf' });
    expect(Buffer.from(copy.bytes).toString('utf8')).toBe('{"event":"three"}\r\n{"event":"two"}\r\n');
    expect(Buffer.from(session.baseBytes).toString('utf8')).toBe('{"event":"one"}\r\n{"event":"two"}\r\n');
  });

  it('supports a partial-tail repair in the export simulation without parsing or writing source', async () => {
    const session = makeSession('{"ok":true}\n{"value":');
    const source = session.baseBytes;
    const start = BigInt(Buffer.from('{"ok":true}\n', 'utf8').byteLength);
    await session.stage(intent(session, [
      editFor(source, start, BigInt(source.byteLength), bytes('{"value":42}\n')),
    ]));
    const copy = await session.simulateExportCopy();
    expect(Buffer.from(copy.bytes).toString('utf8')).toBe('{"ok":true}\n{"value":42}\n');
    expect(copy.sourceUnchanged).toBe(true);
    expect(copy.exportCopyDigest).toBe(sha256(copy.bytes));
  });

  it('replays an exact duplicate and rejects a mismatched idempotency key', async () => {
    const session = makeSession();
    const source = session.baseBytes;
    const edit = editFor(source, 0n, 1n, bytes('['));
    const first = await session.stage(intent(session, [edit]));
    const duplicate = await session.stage(intent(session, [edit]));
    expect(duplicate.diffDigest).toBe(first.diffDigest);
    expect(session.deltas).toHaveLength(1);
    await expectCode(
      () => session.stage(intent(session, [edit], { editRanges: [editFor(source, 0n, 1n, bytes('('))] })),
      'DUPLICATE_INTENT_MISMATCH',
    );
  });

  it('rejects stale generations, unknown digests, and mismatched fences before mutation', async () => {
    const session = makeSession();
    const edit = editFor(session.baseBytes, 0n, 1n, bytes('['));
    await expectCode(() => session.stage(intent(session, [edit], { sourceGeneration: 'source-old' })), 'STALE_SOURCE_GENERATION');
    await expectCode(() => session.stage(intent(session, [edit], { sourceIdentity: 'synthetic://other' })), 'SOURCE_IDENTITY_MISMATCH');
    await expectCode(() => session.stage(intent(session, [edit], { baseGeneration: 'base-old' })), 'STALE_BASE_GENERATION');
    await expectCode(() => session.stage(intent(session, [edit], { baseDigest: sha256(bytes('other')) })), 'BASE_DIGEST_MISMATCH');
    await expectCode(() => session.stage(intent(session, [edit], { fenceToken: 'wrong-fence' })), 'FENCE_MISMATCH');
    const unknown = StagedMutationSession.fromBytes(session.baseBytes, {
      documentId: 'unknown-doc',
      baseDigest: { kind: 'unknown' },
      fenceToken: 'unknown-fence',
    });
    await expectCode(() => unknown.stage(intent(unknown, [editFor(unknown.baseBytes, 0n, 1n, bytes('['))])), 'UNKNOWN_BASE_DIGEST');
    expect(session.deltas).toHaveLength(0);
  });

  it('rejects overlapping, unordered, out-of-bounds, and stale staged intervals', async () => {
    const session = makeSession();
    const source = session.baseBytes;
    const first = editFor(source, 0n, 2n, bytes('[{'));
    const overlap = editFor(source, 1n, 3n, bytes('xx'));
    const unordered = editFor(source, 4n, 5n, bytes('x'));
    await expectCode(() => session.stage(intent(session, [first, overlap])), 'OVERLAP');
    await expectCode(() => session.stage(intent(session, [unordered, first])), 'UNORDERED_EDIT');
    await expectCode(() => session.stage(intent(session, [editFor(source, BigInt(source.byteLength), BigInt(source.byteLength), bytes('x'))])), 'INVALID_RANGE');
    await session.stage(intent(session, [first]));
    await expectCode(() => session.stage(intent(session, [overlap], { operationId: 'op-2', idempotencyKey: 'idem-2' })), 'OVERLAP');
    await expectCode(() => session.stage(intent(session, [editFor(source, 0n, BigInt(source.byteLength + 1), bytes('x'))], { operationId: 'op-3', idempotencyKey: 'idem-3' })), 'RANGE_OUT_OF_BOUNDS');
  });

  it('cancels without changing the immutable base or staging generation', async () => {
    const session = makeSession();
    const controller = new AbortController();
    controller.abort();
    const edit = editFor(session.baseBytes, 0n, 1n, bytes('['));
    await expectCode(() => session.stage(intent(session, [edit]), { signal: controller.signal }), 'CANCELLED');
    expect(session.state).toBe('readOnly');
    expect(session.stagingGeneration).toBe('0');
    expect(session.deltas).toHaveLength(0);
  });

  it('fences unknown commit receipts and requires reconciliation before reuse', async () => {
    const session = makeSession();
    const edit = editFor(session.baseBytes, 0n, 1n, bytes('['));
    await session.stage(intent(session, [edit]));
    const unknown = session.simulateUnknownCommit({
      operationId: 'commit-unknown',
      reason: 'crash after replace before readback',
    });
    expect(unknown.state).toBe('unknownCommit');
    expect(unknown.sourceUnchanged).toBe('unknown');
    await expectCode(() => session.stage(intent(session, [edit], { operationId: 'retry', idempotencyKey: 'retry' })), 'FENCE_HELD');
    session.reconcileUnknownCommit('resolved');
    expect(session.state).toBe('resolved');
    const exportCopy = await session.simulateExportCopy();
    expect(exportCopy.sourceUnchanged).toBe(true);
    expect(Buffer.from(session.baseBytes).toString('utf8')).toBe('{"event":"one"}\r\n{"event":"two"}\r\n');
  });

  it('exposes independent source, base, and staging generations in every receipt', async () => {
    const session = makeSession();
    const edit = editFor(session.baseBytes, 0n, 1n, bytes('['));
    const receipt = await session.stage(intent(session, [edit]));
    expect(receipt.sourceGeneration).toBe('source-7');
    expect(receipt.baseGeneration).toBe('base-3');
    expect(receipt.stagingGeneration).toBe('1');
    expect(receipt.diffDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
