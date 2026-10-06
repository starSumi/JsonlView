import { createHash, randomUUID } from 'node:crypto';

/**
 * Phase 2 experiment only. This module never opens, replaces, or writes a
 * source file. It evaluates staged byte deltas against an immutable snapshot.
 */

export type Digest = `sha256:${string}`;
export type KnownDigest = Digest;
export type BaseDigest = KnownDigest | { readonly kind: 'unknown' };
export type NewlineMode = 'lf' | 'crlf' | 'mixed' | 'none' | 'unknown';
export type MutationState =
  | 'readOnly'
  | 'staging'
  | 'conflict'
  | 'unavailable'
  | 'unknownCommit'
  | 'reconciling'
  | 'resolved';

export interface SourceMetadata {
  readonly documentId: string;
  readonly sourceIdentity: string;
  readonly sourceGeneration: string;
  readonly baseGeneration: string;
  readonly encoding: 'utf-8';
  readonly bom: 'none' | 'utf8';
  readonly newline: NewlineMode;
  readonly baseDigest: BaseDigest;
}

export interface BaseEdit {
  readonly start: bigint;
  readonly endExclusive: bigint;
  readonly replacement: Uint8Array;
  readonly expectedOldDigest: KnownDigest;
}

export interface StageIntent {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly documentId: string;
  readonly sourceIdentity: string;
  readonly sourceGeneration: string;
  readonly baseGeneration: string;
  readonly baseDigest: KnownDigest;
  readonly editRanges: readonly BaseEdit[];
  readonly actor: string;
  readonly capability: 'stage_patch';
  readonly fenceToken: string;
}

export interface Delta extends BaseEdit {
  readonly sequence: number;
}

export interface DiffReceipt {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly documentId: string;
  readonly sourceIdentity: string;
  readonly sourceGeneration: string;
  readonly baseGeneration: string;
  readonly stagingGeneration: string;
  readonly baseDigest: KnownDigest;
  readonly diffDigest: KnownDigest;
  readonly deltas: readonly Delta[];
  readonly sourceUnchanged: true;
  readonly state: 'readOnly';
  readonly fenceToken: string;
}

export interface ExportCopyReceipt extends DiffReceipt {
  readonly exportCopyDigest: KnownDigest;
  readonly bytes: Uint8Array;
  readonly sourceUnchanged: true;
}

export interface UnknownCommitReceipt {
  readonly operationId: string;
  readonly documentId: string;
  readonly sourceIdentity: string;
  readonly sourceGeneration: string;
  readonly baseGeneration: string;
  readonly stagingGeneration: string;
  readonly diffDigest: KnownDigest;
  readonly sourceUnchanged: 'unknown';
  readonly state: 'unknownCommit';
  readonly reason: string;
  readonly fenceToken: string;
}

export type MutationReceipt = DiffReceipt | ExportCopyReceipt | UnknownCommitReceipt;

export type MutationErrorCode =
  | 'CANCELLED'
  | 'INVALID_ARGUMENT'
  | 'DOCUMENT_MISMATCH'
  | 'SOURCE_IDENTITY_MISMATCH'
  | 'STALE_SOURCE_GENERATION'
  | 'STALE_BASE_GENERATION'
  | 'BASE_DIGEST_MISMATCH'
  | 'UNKNOWN_BASE_DIGEST'
  | 'INVALID_RANGE'
  | 'RANGE_OUT_OF_BOUNDS'
  | 'OVERLAP'
  | 'UNORDERED_EDIT'
  | 'DUPLICATE_INTENT_MISMATCH'
  | 'OPERATION_ID_CONFLICT'
  | 'FENCE_MISMATCH'
  | 'FENCE_HELD'
  | 'UNKNOWN_COMMIT_FENCED'
  | 'CAPABILITY_DENIED';

export class StagedMutationError extends Error {
  override readonly name = 'StagedMutationError';

  constructor(
    readonly code: MutationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StageOptions {
  readonly signal?: AbortSignal;
}

export interface ExportOptions extends StageOptions {
  readonly operationId?: string;
}

export interface UnknownCommitOptions {
  readonly operationId?: string;
  readonly reason: string;
}

const UNKNOWN_DIGEST: BaseDigest = { kind: 'unknown' };

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function digest(bytes: Uint8Array): KnownDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestRange(bytes: Uint8Array, start: bigint, endExclusive: bigint): KnownDigest {
  return digest(bytes.slice(Number(start), Number(endExclusive)));
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new StagedMutationError('CANCELLED', 'The staged mutation was cancelled before it could be applied.');
  }
}

function assertNonEmptyText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new StagedMutationError('INVALID_ARGUMENT', `${name} must not be empty.`);
  }
}

function compareEdits(left: BaseEdit, right: BaseEdit): number {
  return left.start < right.start ? -1 : left.start > right.start ? 1 : 0;
}

function editFingerprint(edit: BaseEdit): string {
  return [
    edit.start.toString(),
    edit.endExclusive.toString(),
    edit.expectedOldDigest,
    Buffer.from(edit.replacement).toString('base64'),
  ].join(':');
}

function intentFingerprint(intent: StageIntent): string {
  return JSON.stringify({
    operationId: intent.operationId,
    idempotencyKey: intent.idempotencyKey,
    documentId: intent.documentId,
    sourceIdentity: intent.sourceIdentity,
    sourceGeneration: intent.sourceGeneration,
    baseGeneration: intent.baseGeneration,
    baseDigest: intent.baseDigest,
    editRanges: intent.editRanges.map(editFingerprint),
    actor: intent.actor,
    capability: intent.capability,
    fenceToken: intent.fenceToken,
  });
}

function diffDigest(
  baseDigest: KnownDigest,
  baseGeneration: string,
  deltas: readonly Delta[],
): KnownDigest {
  const canonical = JSON.stringify({
    baseDigest,
    baseGeneration,
    deltas: deltas.map((delta) => ({
      sequence: delta.sequence,
      start: delta.start.toString(),
      endExclusive: delta.endExclusive.toString(),
      expectedOldDigest: delta.expectedOldDigest,
      replacement: Buffer.from(delta.replacement).toString('base64'),
    })),
  });
  return digest(new TextEncoder().encode(canonical));
}

function detectNewline(bytes: Uint8Array): NewlineMode {
  let crlf = 0;
  let lf = 0;
  let bareCr = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] === 0x0a) crlf += 1;
      else bareCr += 1;
    } else if (bytes[index] === 0x0a && bytes[index - 1] !== 0x0d) {
      lf += 1;
    }
  }
  if (crlf === 0 && lf === 0 && bareCr === 0) return 'none';
  if (bareCr > 0 || (crlf > 0 && lf > 0)) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function cloneDelta(delta: Delta): Delta {
  return {
    ...delta,
    replacement: copyBytes(delta.replacement),
  };
}

/**
 * An immutable-base, ordered-delta staging coordinator for Phase 2. The
 * operation is intentionally synchronous in its state transition but exposed
 * as a Promise so cancellation/fencing can be exercised by future adapters.
 */
export class StagedMutationSession {
  readonly metadata: SourceMetadata;
  readonly baseBytes: Uint8Array;
  readonly fenceToken: string;

  private stateValue: MutationState = 'readOnly';
  private stagingGenerationValue = 0n;
  private sequenceValue = 0;
  private heldFence = false;
  private readonly deltasValue: Delta[] = [];
  private readonly idempotency = new Map<string, { fingerprint: string; receipt: DiffReceipt }>();
  private readonly operations = new Map<string, { fingerprint: string; receipt: DiffReceipt }>();

  private constructor(
    baseBytes: Uint8Array,
    metadata: SourceMetadata,
    fenceToken: string,
  ) {
    this.baseBytes = copyBytes(baseBytes);
    this.metadata = {
      ...metadata,
      baseDigest: typeof metadata.baseDigest === 'string' ? metadata.baseDigest : UNKNOWN_DIGEST,
    };
    this.fenceToken = fenceToken;
  }

  static fromBytes(
    bytes: Uint8Array,
    options: {
      readonly documentId: string;
      readonly sourceIdentity?: string;
      readonly sourceGeneration?: string;
      readonly baseGeneration?: string;
      readonly baseDigest?: BaseDigest;
      readonly encoding?: 'utf-8';
      readonly bom?: 'none' | 'utf8';
      readonly newline?: NewlineMode;
      readonly fenceToken?: string;
    },
  ): StagedMutationSession {
    assertNonEmptyText(options.documentId, 'documentId');
    const copied = copyBytes(bytes);
    const baseDigest = options.baseDigest ?? digest(copied);
    return new StagedMutationSession(
      copied,
      {
        documentId: options.documentId,
        sourceIdentity: options.sourceIdentity ?? options.documentId,
        sourceGeneration: options.sourceGeneration ?? 'source-0',
        baseGeneration: options.baseGeneration ?? 'base-0',
        encoding: options.encoding ?? 'utf-8',
        bom: options.bom ?? 'none',
        newline: options.newline ?? detectNewline(copied),
        baseDigest,
      },
      options.fenceToken ?? `fence-${randomUUID()}`,
    );
  }

  get state(): MutationState {
    return this.stateValue;
  }

  get stagingGeneration(): string {
    return this.stagingGenerationValue.toString();
  }

  get deltas(): readonly Delta[] {
    return this.deltasValue.map(cloneDelta);
  }

  get sourceUnchanged(): boolean | 'unknown' {
    return this.stateValue === 'unknownCommit' ? 'unknown' : true;
  }

  async stage(intent: StageIntent, options: StageOptions = {}): Promise<DiffReceipt> {
    abortIfNeeded(options.signal);
    this.assertAvailable();
    this.assertIntentHeader(intent);
    const fingerprint = intentFingerprint(intent);
    const priorByIdempotency = this.idempotency.get(intent.idempotencyKey);
    if (priorByIdempotency !== undefined) {
      if (priorByIdempotency.fingerprint !== fingerprint) {
        throw new StagedMutationError('DUPLICATE_INTENT_MISMATCH', 'The idempotency key was already used for a different intent.');
      }
      return cloneReceipt(priorByIdempotency.receipt);
    }
    const priorByOperation = this.operations.get(intent.operationId);
    if (priorByOperation !== undefined) {
      if (priorByOperation.fingerprint !== fingerprint) {
        throw new StagedMutationError('OPERATION_ID_CONFLICT', 'The operation ID was already used for a different intent.');
      }
      return cloneReceipt(priorByOperation.receipt);
    }
    this.validateEdits(intent.editRanges);
    abortIfNeeded(options.signal);

    this.stateValue = 'staging';
    const staged: Delta[] = intent.editRanges.map((edit) => ({
      ...edit,
      replacement: copyBytes(edit.replacement),
      sequence: ++this.sequenceValue,
    }));
    this.deltasValue.push(...staged);
    this.deltasValue.sort(compareEdits);
    this.stagingGenerationValue += 1n;
    const receipt: DiffReceipt = {
      operationId: intent.operationId,
      idempotencyKey: intent.idempotencyKey,
      documentId: this.metadata.documentId,
      sourceIdentity: this.metadata.sourceIdentity,
      sourceGeneration: this.metadata.sourceGeneration,
      baseGeneration: this.metadata.baseGeneration,
      stagingGeneration: this.stagingGeneration,
      baseDigest: this.requireKnownBaseDigest(),
      diffDigest: diffDigest(this.requireKnownBaseDigest(), this.metadata.baseGeneration, this.deltasValue),
      deltas: this.deltas,
      sourceUnchanged: true,
      state: 'readOnly',
      fenceToken: this.fenceToken,
    };
    this.stateValue = 'readOnly';
    this.idempotency.set(intent.idempotencyKey, { fingerprint, receipt });
    this.operations.set(intent.operationId, { fingerprint, receipt });
    return cloneReceipt(receipt);
  }

  async simulateExportCopy(options: ExportOptions = {}): Promise<ExportCopyReceipt> {
    abortIfNeeded(options.signal);
    this.assertAvailable();
    const bytes = this.materialize();
    abortIfNeeded(options.signal);
    const baseDigest = this.requireKnownBaseDigest();
    const operationId = options.operationId ?? `export-${this.stagingGeneration}`;
    return {
      operationId,
      idempotencyKey: `export:${this.metadata.documentId}:${this.stagingGeneration}`,
      documentId: this.metadata.documentId,
      sourceIdentity: this.metadata.sourceIdentity,
      sourceGeneration: this.metadata.sourceGeneration,
      baseGeneration: this.metadata.baseGeneration,
      stagingGeneration: this.stagingGeneration,
      baseDigest,
      diffDigest: diffDigest(baseDigest, this.metadata.baseGeneration, this.deltasValue),
      deltas: this.deltas,
      sourceUnchanged: true,
      state: 'readOnly',
      fenceToken: this.fenceToken,
      exportCopyDigest: digest(bytes),
      bytes,
    };
  }

  simulateUnknownCommit(options: UnknownCommitOptions): UnknownCommitReceipt {
    assertNonEmptyText(options.reason, 'reason');
    this.assertAvailable();
    this.heldFence = true;
    this.stateValue = 'unknownCommit';
    return {
      operationId: options.operationId ?? `unknown-${this.stagingGeneration}`,
      documentId: this.metadata.documentId,
      sourceIdentity: this.metadata.sourceIdentity,
      sourceGeneration: this.metadata.sourceGeneration,
      baseGeneration: this.metadata.baseGeneration,
      stagingGeneration: this.stagingGeneration,
      diffDigest: diffDigest(this.requireKnownBaseDigest(), this.metadata.baseGeneration, this.deltasValue),
      sourceUnchanged: 'unknown',
      state: 'unknownCommit',
      reason: options.reason,
      fenceToken: this.fenceToken,
    };
  }

  reconcileUnknownCommit(outcome: 'resolved' | 'conflict' | 'unavailable'): void {
    if (this.stateValue !== 'unknownCommit') {
      throw new StagedMutationError('INVALID_ARGUMENT', 'Only an unknown commit can be reconciled.');
    }
    this.stateValue = 'reconciling';
    this.stateValue = outcome === 'resolved' ? 'resolved' : outcome;
    if (outcome === 'resolved') this.heldFence = false;
  }

  materialize(): Uint8Array {
    this.assertAvailable();
    const output: Uint8Array[] = [];
    let cursor = 0n;
    for (const delta of this.deltasValue) {
      output.push(this.baseBytes.slice(Number(cursor), Number(delta.start)));
      output.push(copyBytes(delta.replacement));
      cursor = delta.endExclusive;
    }
    output.push(this.baseBytes.slice(Number(cursor)));
    const total = output.reduce((sum, part) => sum + part.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of output) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }

  private assertAvailable(): void {
    if (this.heldFence || this.stateValue === 'unknownCommit') {
      throw new StagedMutationError('FENCE_HELD', 'The authority fence is held by an unresolved unknown commit.');
    }
  }

  private requireKnownBaseDigest(): KnownDigest {
    if (typeof this.metadata.baseDigest !== 'string') {
      throw new StagedMutationError('UNKNOWN_BASE_DIGEST', 'The base digest is unknown; staging requires an exact snapshot digest.');
    }
    return this.metadata.baseDigest;
  }

  private assertIntentHeader(intent: StageIntent): void {
    if (intent.capability !== 'stage_patch') {
      throw new StagedMutationError('CAPABILITY_DENIED', 'Only the stage_patch capability is available in this experiment.');
    }
    if (intent.documentId !== this.metadata.documentId) {
      throw new StagedMutationError('DOCUMENT_MISMATCH', 'The intent document does not match the immutable base.');
    }
    if (intent.sourceIdentity !== this.metadata.sourceIdentity) {
      throw new StagedMutationError('SOURCE_IDENTITY_MISMATCH', 'The intent source identity does not match the immutable base.');
    }
    if (intent.sourceGeneration !== this.metadata.sourceGeneration) {
      throw new StagedMutationError('STALE_SOURCE_GENERATION', 'The source generation is stale.');
    }
    if (intent.baseGeneration !== this.metadata.baseGeneration) {
      throw new StagedMutationError('STALE_BASE_GENERATION', 'The base generation is stale.');
    }
    if (typeof this.metadata.baseDigest !== 'string') {
      throw new StagedMutationError('UNKNOWN_BASE_DIGEST', 'The immutable base digest is unknown.');
    }
    if (intent.baseDigest !== this.metadata.baseDigest) {
      throw new StagedMutationError('BASE_DIGEST_MISMATCH', 'The base digest does not match the immutable snapshot.');
    }
    if (intent.fenceToken !== this.fenceToken) {
      throw new StagedMutationError('FENCE_MISMATCH', 'The intent fence token does not belong to this coordinator.');
    }
    assertNonEmptyText(intent.operationId, 'operationId');
    assertNonEmptyText(intent.idempotencyKey, 'idempotencyKey');
    assertNonEmptyText(intent.actor, 'actor');
  }

  private validateEdits(edits: readonly BaseEdit[]): void {
    if (edits.length === 0) {
      throw new StagedMutationError('INVALID_RANGE', 'An intent must contain at least one base-byte edit range.');
    }
    let previous: BaseEdit | undefined;
    for (const edit of edits) {
      if (edit.start < 0n || edit.endExclusive <= edit.start) {
        throw new StagedMutationError('INVALID_RANGE', 'Edit ranges must be non-empty and ordered base-byte intervals.');
      }
      if (edit.endExclusive > BigInt(this.baseBytes.byteLength)) {
        throw new StagedMutationError('RANGE_OUT_OF_BOUNDS', 'An edit range exceeds the immutable base bytes.');
      }
      if (previous !== undefined) {
        if (edit.start < previous.start) {
          throw new StagedMutationError('UNORDERED_EDIT', 'Edit ranges must be ordered by base-byte start.');
        }
        if (edit.start < previous.endExclusive) {
          throw new StagedMutationError('OVERLAP', 'Edit ranges may not overlap.');
        }
      }
      const expectedDigest = digestRange(this.baseBytes, edit.start, edit.endExclusive);
      if (expectedDigest !== edit.expectedOldDigest) {
        throw new StagedMutationError('BASE_DIGEST_MISMATCH', 'The expected old-byte digest does not match the immutable base.');
      }
      previous = edit;
    }
    for (const prior of this.deltasValue) {
      for (const edit of edits) {
        if (edit.start < prior.endExclusive && prior.start < edit.endExclusive) {
          throw new StagedMutationError('OVERLAP', 'A new edit overlaps an already staged base-byte interval.');
        }
      }
    }
  }
}

function cloneReceipt(receipt: DiffReceipt): DiffReceipt {
  return {
    ...receipt,
    deltas: receipt.deltas.map(cloneDelta),
  };
}

export function sha256(bytes: Uint8Array): KnownDigest {
  return digest(bytes);
}

export function editFor(
  base: Uint8Array,
  start: bigint,
  endExclusive: bigint,
  replacement: Uint8Array,
): BaseEdit {
  return {
    start,
    endExclusive,
    replacement: copyBytes(replacement),
    expectedOldDigest: digestRange(base, start, endExclusive),
  };
}
