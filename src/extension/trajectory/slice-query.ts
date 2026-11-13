import { performance } from 'node:perf_hooks';
import { AgentProfileRegistry } from '@profiles/profile-registry';
import type { GenericRecordSample } from '@profiles/profile-contract';
import { projectTrajectory } from '@profiles/trajectory-projection';
import { matchesTrajectory, measureTrajectoryResult, TRAJECTORY_RESULT_SCHEMA, trajectoryError,
  type TrajectoryErrorCode, type TrajectoryPartialReason, type TrajectoryPredicate, type TrajectoryRecord,
  type TrajectorySliceRequest, type TrajectorySliceResult } from '@shared/contracts/trajectory-slice';
import { canonicalJson, createTrajectoryCursor, parseTrajectoryCursor, TRAJECTORY_CURSOR_TTL_MS, trajectoryQueryHash } from './cursor';
import { AuthorizedTrajectorySource, TrajectoryFailure, type TrajectorySourceOptions } from './source';
import { createHash } from 'node:crypto';

const CHUNK_BYTES = 65_536;
const DETECTION_ROWS = 96;
const MAX_EXAMINED_RECORDS = 1_000_000;
export interface TrajectoryQueryOptions extends TrajectorySourceOptions {
  readonly registry?: AgentProfileRegistry;
  readonly maxCheckpoints?: number;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
}
export type TrajectoryScanRequest = Omit<TrajectorySliceRequest, 'schema' | 'predicate'>;
export interface TrajectoryOmissions { readonly invalidJson: number; readonly unknownActor: number; readonly toolPayloads: number; readonly textTruncated: number }
export interface TrajectoryScanPage {
  readonly requestId: string;
  readonly sourceId: string;
  readonly profile: { readonly id: string; readonly version: string };
  readonly snapshot: { readonly id: string; readonly guarantee: 'observed-metadata' };
  readonly records: readonly TrajectoryRecord[];
  readonly usage: { readonly examinedBytes: string; readonly examinedRecords: number; readonly returnedBytes: number };
  readonly omitted: TrajectoryOmissions;
  readonly status: 'complete' | 'partial';
  readonly reason?: TrajectoryPartialReason;
  readonly cursor?: string;
}
export interface TrajectoryScanError { readonly status: 'error'; readonly code: TrajectoryErrorCode }
export interface TrajectoryScanMode {
  /** null is the explicit internal match-all spine mode; it is never a slice predicate. */
  readonly predicate: TrajectoryPredicate | null;
  readonly measure: (page: TrajectoryScanPage) => number;
}
interface Locator { readonly offset: bigint; readonly profile: { id: string; version: string } }
interface PhysicalRow { readonly ordinal: bigint; readonly byteStart: bigint; readonly byteEnd: bigint; readonly nextOffset: bigint; readonly value: unknown; readonly valid: boolean }
interface Budget { examinedBytes: number; examinedRecords: number; readonly maxBytes: number; readonly check: () => void }
class ScanStop extends Error {
  public readonly reason: 'scan_limit' | 'deadline';
  public constructor(reason: 'scan_limit' | 'deadline') { super(reason); this.reason = reason; }
}

/** Portable oracle. The bounded locator accelerates hot cursors, never changes cursor v1. */
export class TrajectorySliceQuery {
  private readonly options: TrajectoryQueryOptions;
  private readonly registry: AgentProfileRegistry;
  private readonly locators = new Map<string, Locator>();
  private readonly profiles = new Map<string, { id: string; version: string }>();
  private readonly maxCheckpoints: number;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;
  public constructor(options: TrajectoryQueryOptions) {
    this.options = options;
    this.registry = options.registry ?? new AgentProfileRegistry();
    this.maxCheckpoints = options.maxCheckpoints !== undefined && Number.isFinite(options.maxCheckpoints)
      ? Math.min(1024, Math.max(1, Math.floor(options.maxCheckpoints))) : 128;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
  }

  public async query(request: TrajectorySliceRequest, signal?: AbortSignal): Promise<TrajectorySliceResult> {
    const result = await this.scan(request, { predicate: request.predicate,
      measure: (page) => measureTrajectoryResult(sliceResult(page)).byteLength }, signal);
    return result.status === 'error' ? trajectoryError(request.requestId, result.code) : measureTrajectoryResult(sliceResult(result)).result;
  }

  /** Shared physical scan/authority/budget boundary for the independent spine serializer. */
  public async scan(request: TrajectoryScanRequest, mode: TrajectoryScanMode, signal?: AbortSignal): Promise<TrajectoryScanPage | TrajectoryScanError> {
    const started = this.monotonicNow();
    let source: AuthorizedTrajectorySource | undefined;
    const check = (): void => {
      if (signal?.aborted) throw new TrajectoryFailure('CANCELLED');
      if (this.monotonicNow() - started >= request.deadlineMs) throw new ScanStop('deadline');
    };
    const budget: Budget = { examinedBytes: 0, examinedRecords: 0, maxBytes: request.maxExaminedBytes, check };
    try {
      check();
      const cursor = request.cursor === undefined ? undefined : parseTrajectoryCursor(request.cursor);
      if (request.cursor !== undefined && (cursor === undefined || cursor.sourceId !== request.sourceId || cursor.expiresAtMs <= this.wallNow())) {
        throw new TrajectoryFailure('STALE_CURSOR');
      }
      source = await AuthorizedTrajectorySource.open(this.options, request.sourceId, signal);
      check();
      if (cursor !== undefined && cursor.snapshotId !== source.snapshotId) throw new TrajectoryFailure('STALE_CURSOR');
      const startOrdinal = BigInt(cursor?.nextOrdinal ?? '0');
      if (startOrdinal > source.size) throw new TrajectoryFailure('STALE_CURSOR');
      const checkpointKey = `${source.snapshotId}:${startOrdinal}`;
      const checkpoint = touch(this.locators, checkpointKey);
      let profile = checkpoint?.profile ?? touch(this.profiles, source.snapshotId);
      const reader = new PhysicalReader(source, checkpoint?.offset ?? 0n, checkpoint === undefined ? 0n : startOrdinal, budget, signal);
      const initial: PhysicalRow[] = [];
      if (profile === undefined) {
        const samples: GenericRecordSample[] = [];
        for (let index = 0; index < DETECTION_ROWS; index++) {
          const row = await reader.next();
          if (row === undefined) break;
          initial.push(row);
          samples.push({ value: row.value, ordinal: row.ordinal.toString(), parseState: row.valid ? 'valid' : 'invalid_json' });
        }
        const selected = this.registry.detect(samples);
        profile = { id: selected.selectedProfileId, version: selected.selectedProfileVersion };
        putBounded(this.profiles, source.snapshotId, profile, this.maxCheckpoints);
      }
      if (this.registry.version(profile.id) !== profile.version) throw new TrajectoryFailure('UNSUPPORTED_PROFILE');
      const queryHash = mode.predicate === null
        ? createHash('sha256').update(canonicalJson({ mode: 'spine-v1', profileId: profile.id, profileVersion: profile.version })).digest('hex')
        : trajectoryQueryHash(mode.predicate, profile.id, profile.version);
      if (cursor !== undefined && cursor.queryHash !== queryHash) throw new TrajectoryFailure('STALE_CURSOR');
      const records: TrajectoryRecord[] = [];
      const omitted = { invalidJson: 0, unknownActor: 0, toolPayloads: 0, textTruncated: 0 };
      const openedSource = source;
      let nextOrdinal = startOrdinal;
      let nextOffset = checkpoint?.offset ?? 0n;
      let initialIndex = 0;
      let reachedStart = checkpoint !== undefined || startOrdinal === 0n;
      const page = (reason?: TrajectoryPartialReason): TrajectoryScanPage => ({ requestId: request.requestId, sourceId: request.sourceId,
        profile, snapshot: { id: openedSource.snapshotId, guarantee: 'observed-metadata' }, records,
        usage: { examinedBytes: budget.examinedBytes.toString(), examinedRecords: budget.examinedRecords, returnedBytes: 0 }, omitted,
        status: reason === undefined ? 'complete' : 'partial', ...(reason === undefined ? {} : { reason,
          cursor: createTrajectoryCursor({ sourceId: request.sourceId, snapshotId: openedSource.snapshotId, queryHash,
            nextOrdinal: nextOrdinal.toString(), expiresAtMs: this.wallNow() + TRAJECTORY_CURSOR_TTL_MS }) }) });
      let reason: TrajectoryPartialReason | undefined;
      try {
        while (true) {
          check();
          const row = initial[initialIndex++] ?? await reader.next();
          if (row === undefined) {
            if (!reachedStart && startOrdinal !== reader.ordinal) throw new TrajectoryFailure('STALE_CURSOR');
            break;
          }
          if (row.ordinal < startOrdinal) { nextOffset = row.nextOffset; continue; }
          reachedStart = true;
          const previousOmitted = { ...omitted };
          if (!row.valid) omitted.invalidJson++;
          const projection = row.valid ? projectTrajectory(this.registry, profile, row.value, source.snapshotId) : undefined;
          const matched = projection !== undefined && (mode.predicate === null || matchesTrajectory(projection, mode.predicate));
          let record: TrajectoryRecord | undefined;
          if (matched && projection !== undefined) {
            if (mode.predicate === null && projection.actor === 'unknown') omitted.unknownActor++;
            else {
              const omitToolText = mode.predicate === null && projection.actor === 'tool'
                && (projection.textTruncated || Buffer.byteLength(projection.text ?? '', 'utf8') > 1024);
              record = { ordinal: row.ordinal.toString(), byteStart: row.byteStart.toString(), byteEnd: row.byteEnd.toString(),
                actor: projection.actor, hasError: projection.hasError, text: omitToolText ? null : projection.text };
              if (omitToolText) omitted.toolPayloads++;
              if (projection.textTruncated) omitted.textTruncated++;
            }
          }
          if (record !== undefined) {
            records.push(record);
            const previousOrdinal = nextOrdinal;
            nextOrdinal = row.ordinal + 1n;
            const candidate = page(row.nextOffset === source.size ? undefined : 'output_limit');
            if (mode.measure(candidate) > request.maxOutputBytes) {
              records.pop();
              Object.assign(omitted, previousOmitted);
              nextOrdinal = previousOrdinal;
              if (nextOrdinal === startOrdinal) throw new TrajectoryFailure('BUDGET_TOO_SMALL');
              reason = 'output_limit';
              break;
            }
          }
          nextOrdinal = row.ordinal + 1n;
          nextOffset = row.nextOffset;
          if (nextOffset === source.size) break;
          if (records.length >= request.limit) { reason = 'record_limit'; break; }
        }
      } catch (error) {
        if (!(error instanceof ScanStop)) throw error;
        if (nextOrdinal === startOrdinal) throw new TrajectoryFailure(error.reason === 'deadline' ? 'DEADLINE_EXCEEDED' : 'BUDGET_TOO_SMALL');
        reason = error.reason;
      }
      if (reason !== undefined && nextOrdinal === startOrdinal) throw new TrajectoryFailure('BUDGET_TOO_SMALL');
      // Publication fence is mandatory even for empty/partial pages.
      await source.verifyUnchanged(signal);
      if (signal?.aborted) throw new TrajectoryFailure('CANCELLED');
      if (this.monotonicNow() - started >= request.deadlineMs) {
        if (nextOrdinal === startOrdinal) throw new TrajectoryFailure('DEADLINE_EXCEEDED');
        reason = 'deadline';
      }
      const result = page(reason);
      if (mode.measure(result) > request.maxOutputBytes) throw new TrajectoryFailure('BUDGET_TOO_SMALL');
      if (reason !== undefined) putBounded(this.locators, `${source.snapshotId}:${nextOrdinal}`, { offset: nextOffset, profile }, this.maxCheckpoints);
      return result;
    } catch (error) {
      return { status: 'error', code: error instanceof TrajectoryFailure ? error.code
        : error instanceof ScanStop ? error.reason === 'deadline' ? 'DEADLINE_EXCEEDED' : 'BUDGET_TOO_SMALL' : 'IO_FAILED' };
    } finally { await source?.close().catch(() => undefined); }
  }
}

function sliceResult(page: TrajectoryScanPage): TrajectorySliceResult {
  const base = { schema: TRAJECTORY_RESULT_SCHEMA, requestId: page.requestId, sourceId: page.sourceId,
    profile: page.profile, snapshot: page.snapshot, records: page.records, usage: page.usage };
  if (page.status === 'partial' && page.reason !== undefined && page.cursor !== undefined) return { ...base, status: 'partial', reason: page.reason, cursor: page.cursor };
  return { ...base, status: 'complete' };
}

class PhysicalReader {
  private readonly source: AuthorizedTrajectorySource;
  private readonly budget: Budget;
  private readonly signal: AbortSignal | undefined;
  public ordinal: bigint;
  private buffer: Buffer = Buffer.alloc(0);
  private bufferIndex = 0;
  private position: bigint;
  private lineStart: bigint;
  public constructor(source: AuthorizedTrajectorySource, offset: bigint, ordinal: bigint,
    budget: Budget, signal?: AbortSignal) {
    this.source = source; this.ordinal = ordinal; this.budget = budget; this.signal = signal;
    this.position = offset; this.lineStart = offset;
  }
  public async next(): Promise<PhysicalRow | undefined> {
    this.budget.check();
    if (this.lineStart === this.source.size) return undefined;
    if (this.budget.examinedRecords >= MAX_EXAMINED_RECORDS) throw new ScanStop('scan_limit');
    const pieces: Buffer[] = [];
    let length = 0;
    while (true) {
      this.budget.check();
      if (this.bufferIndex >= this.buffer.length) {
        if (this.position === this.source.size) return this.row(Buffer.concat(pieces, length), this.position, false);
        const remaining = this.budget.maxBytes - this.budget.examinedBytes;
        if (remaining <= 0) throw new ScanStop('scan_limit');
        const amount = Math.min(CHUNK_BYTES, remaining, Number(this.source.size - this.position > BigInt(CHUNK_BYTES) ? BigInt(CHUNK_BYTES) : this.source.size - this.position));
        this.buffer = await this.source.readAt(this.position, amount, this.signal);
        this.budget.examinedBytes += this.buffer.length;
        if (this.buffer.length === 0) throw new TrajectoryFailure('SOURCE_CHANGED');
        this.position += BigInt(this.buffer.length);
        this.bufferIndex = 0;
      }
      const newline = this.buffer.indexOf(10, this.bufferIndex);
      const end = newline === -1 ? this.buffer.length : newline;
      const part = this.buffer.subarray(this.bufferIndex, end);
      pieces.push(part); length += part.length;
      this.bufferIndex = end + (newline === -1 ? 0 : 1);
      if (newline !== -1) {
        const content = Buffer.concat(pieces, length);
        const nextOffset = this.position - BigInt(this.buffer.length - this.bufferIndex);
        return this.row(content, nextOffset, true);
      }
    }
  }
  private row(bytes: Buffer, nextOffset: bigint, hasNewline: boolean): PhysicalRow {
    const content = hasNewline && bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes;
    let value: unknown;
    let valid = false;
    try {
      let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
      if (this.ordinal === 0n && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      value = JSON.parse(text); valid = true;
    } catch { /* Invalid JSON/UTF-8 remains a physical row, with no semantic match. */ }
    const row = { ordinal: this.ordinal, byteStart: this.lineStart, byteEnd: this.lineStart + BigInt(content.length), nextOffset, value, valid };
    this.lineStart = nextOffset; this.ordinal++; this.budget.examinedRecords++;
    return row;
  }
}
function touch<T>(map: Map<string, T>, key: string): T | undefined { const value = map.get(key); if (value !== undefined) { map.delete(key); map.set(key, value); } return value; }
function putBounded<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key); map.set(key, value);
  while (map.size > limit) { const oldest = map.keys().next().value; if (oldest !== undefined) map.delete(oldest); }
}
