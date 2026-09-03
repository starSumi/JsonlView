import type { FileHandle } from 'node:fs/promises';
import type { ParseState, RecordRef } from '../shared/types';
import { JsonlEngineError } from './errors';
import {
  MAX_NEWLINE_SCAN_BYTES,
  type NewlineScanner,
  type NewlineScannerDiagnostics,
} from './newline-scanner';

export interface InternalRecordRef {
  ordinal: bigint;
  byteStart: bigint;
  byteEndExclusive: bigint;
  contentByteLength: bigint;
  delimiterByteLength: 0 | 1 | 2;
  parseState: ParseState;
}

interface SegmentMeta {
  id: number;
  firstOrdinal: bigint;
  recordCount: number;
  byteStart: bigint;
  physicalEndExclusive: bigint;
}

export interface SegmentLocation {
  segmentId: number;
  localIndex: number;
  segmentCapacity: number;
}

export interface SegmentIndexOptions {
  readChunkBytes: number;
  segmentTargetBytes: number;
  segmentTargetRecords: number;
  exactCacheSegments: number;
  maxRecordBytes: number;
  newlineScanner: NewlineScanner;
  validateSnapshot: () => Promise<void>;
}

export interface SegmentIndexDiagnostics {
  segmentCount: number;
  exactCachedSegments: number;
  pendingExactRecords: number;
  indexedBytes: string;
  indexedRecords: string;
  complete: boolean;
  newlineScanner: NewlineScannerDiagnostics;
}

type OperationGuard = () => void;

/**
 * Stores one compact summary per segment. Exact refs are reconstructed only for
 * the active page and retained in a bounded LRU.
 */
export class AdaptiveSegmentIndex {
  private readonly segments: SegmentMeta[] = [];
  private readonly exactCache = new Map<number, InternalRecordRef[]>();
  private pendingRefs: InternalRecordRef[] = [];
  private scanOffset = 0n;
  private lineStart = 0n;
  private previousByte: number | undefined;
  private nextOrdinal = 0n;
  private complete = false;

  constructor(
    private readonly handle: FileHandle,
    private readonly fileSize: bigint,
    private readonly options: SegmentIndexOptions,
  ) {}

  get indexedBytes(): bigint {
    return this.scanOffset;
  }

  get indexedRecords(): bigint {
    return this.nextOrdinal;
  }

  get indexingComplete(): boolean {
    return this.complete;
  }

  get totalRecords(): bigint | undefined {
    return this.complete ? this.nextOrdinal : undefined;
  }

  diagnostics(): SegmentIndexDiagnostics {
    return {
      segmentCount: this.segments.length + (this.pendingRefs.length > 0 ? 1 : 0),
      exactCachedSegments: this.exactCache.size,
      pendingExactRecords: this.pendingRefs.length,
      indexedBytes: this.scanOffset.toString(),
      indexedRecords: this.nextOrdinal.toString(),
      complete: this.complete,
      newlineScanner: this.options.newlineScanner.diagnostics(),
    };
  }

  async indexMore(maxBytes: number, guard: OperationGuard): Promise<void> {
    if (this.complete || maxBytes <= 0) return;
    const startingOffset = this.scanOffset;
    while (!this.complete && this.scanOffset - startingOffset < BigInt(maxBytes)) {
      guard();
      await this.scanNextChunk(guard);
    }
  }

  async finish(guard: OperationGuard): Promise<void> {
    while (!this.complete) {
      guard();
      await this.scanNextChunk(guard);
    }
  }

  async ensureOrdinal(ordinal: bigint, guard: OperationGuard): Promise<boolean> {
    if (ordinal < 0n) return false;
    while (!this.complete && this.nextOrdinal <= ordinal) {
      guard();
      await this.scanNextChunk(guard);
    }
    return ordinal < this.nextOrdinal;
  }

  async getRecord(ordinal: bigint, guard: OperationGuard): Promise<InternalRecordRef | undefined> {
    if (!(await this.ensureOrdinal(ordinal, guard))) return undefined;

    const finalized = this.findFinalizedSegment(ordinal);
    if (finalized !== undefined) {
      const refs = await this.loadSegment(finalized, guard);
      return refs[Number(ordinal - finalized.firstOrdinal)];
    }

    if (this.pendingRefs.length === 0) return undefined;
    const first = this.pendingRefs[0];
    if (first === undefined) return undefined;
    return this.pendingRefs[Number(ordinal - first.ordinal)];
  }

  locate(ordinal: bigint): SegmentLocation | undefined {
    const finalized = this.findFinalizedSegment(ordinal);
    if (finalized !== undefined) {
      return {
        segmentId: finalized.id,
        localIndex: Number(ordinal - finalized.firstOrdinal),
        segmentCapacity: finalized.recordCount,
      };
    }

    const first = this.pendingRefs[0];
    if (first === undefined || ordinal < first.ordinal || ordinal >= first.ordinal + BigInt(this.pendingRefs.length)) {
      return undefined;
    }
    return {
      segmentId: this.segments.length,
      localIndex: Number(ordinal - first.ordinal),
      segmentCapacity: this.options.segmentTargetRecords,
    };
  }

  toPublic(ref: InternalRecordRef, generation: string): RecordRef {
    return {
      generation,
      ordinal: ref.ordinal.toString(),
      byteStart: ref.byteStart.toString(),
      byteEndExclusive: ref.byteEndExclusive.toString(),
      contentByteLength: ref.contentByteLength.toString(),
      delimiterByteLength: ref.delimiterByteLength,
      parseState: ref.parseState,
    };
  }

  private async scanNextChunk(guard: OperationGuard): Promise<void> {
    if (this.scanOffset >= this.fileSize) {
      this.finishAtEof();
      return;
    }

    const remaining = this.fileSize - this.scanOffset;
    const configuredReadBytes = Math.min(this.options.readChunkBytes, MAX_NEWLINE_SCAN_BYTES);
    const length = Number(remaining < BigInt(configuredReadBytes)
      ? remaining
      : BigInt(configuredReadBytes));
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, this.scanOffset);
    guard();
    if (bytesRead <= 0) {
      throw new JsonlEngineError(
        'UNEXPECTED_EOF',
        'The JSONL source became shorter while its snapshot was being indexed.',
      );
    }

    const base = this.scanOffset;
    const chunk = buffer.subarray(0, bytesRead);
    const newlineOffsets = this.options.newlineScanner.scan(chunk);
    await this.options.validateSnapshot();
    guard();
    newlineOffsets.forEach((index) => {
      const absolute = base + BigInt(index);
      const precedingByte = index === 0 ? this.previousByte : chunk[index - 1];
      const hasCarriageReturn = precedingByte === 0x0d;
      const contentEnd = hasCarriageReturn ? absolute - 1n : absolute;
      this.emitRecord(contentEnd, hasCarriageReturn ? 2 : 1, absolute + 1n);
    });
    this.previousByte = chunk[bytesRead - 1];

    this.scanOffset += BigInt(bytesRead);
    if (this.scanOffset >= this.fileSize) this.finishAtEof();
  }

  private finishAtEof(): void {
    if (this.complete) return;
    if (this.lineStart < this.fileSize) {
      this.emitRecord(this.fileSize, 0, this.fileSize);
    }
    this.finalizePending();
    this.complete = true;
  }

  private emitRecord(
    byteEndExclusive: bigint,
    delimiterByteLength: 0 | 1 | 2,
    physicalEndExclusive: bigint,
  ): void {
    const contentByteLength = byteEndExclusive - this.lineStart;
    const ref: InternalRecordRef = {
      ordinal: this.nextOrdinal,
      byteStart: this.lineStart,
      byteEndExclusive,
      contentByteLength,
      delimiterByteLength,
      parseState: contentByteLength > BigInt(this.options.maxRecordBytes) ? 'oversized' : 'unknown',
    };
    this.pendingRefs.push(ref);
    this.nextOrdinal += 1n;
    this.lineStart = physicalEndExclusive;

    const first = this.pendingRefs[0];
    const pendingBytes = first === undefined ? 0n : physicalEndExclusive - first.byteStart;
    if (
      this.pendingRefs.length >= this.options.segmentTargetRecords
      || pendingBytes >= BigInt(this.options.segmentTargetBytes)
    ) {
      this.finalizePending();
    }
  }

  private finalizePending(): void {
    const first = this.pendingRefs[0];
    const last = this.pendingRefs[this.pendingRefs.length - 1];
    if (first === undefined || last === undefined) return;

    const id = this.segments.length;
    const meta: SegmentMeta = {
      id,
      firstOrdinal: first.ordinal,
      recordCount: this.pendingRefs.length,
      byteStart: first.byteStart,
      physicalEndExclusive: last.byteEndExclusive + BigInt(last.delimiterByteLength),
    };
    this.segments.push(meta);
    this.putCache(id, this.pendingRefs);
    this.pendingRefs = [];
  }

  private findFinalizedSegment(ordinal: bigint): SegmentMeta | undefined {
    let low = 0;
    let high = this.segments.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const segment = this.segments[middle];
      if (segment === undefined) return undefined;
      const end = segment.firstOrdinal + BigInt(segment.recordCount);
      if (ordinal < segment.firstOrdinal) high = middle - 1;
      else if (ordinal >= end) low = middle + 1;
      else return segment;
    }
    return undefined;
  }

  private async loadSegment(meta: SegmentMeta, guard: OperationGuard): Promise<InternalRecordRef[]> {
    const cached = this.exactCache.get(meta.id);
    if (cached !== undefined) {
      this.exactCache.delete(meta.id);
      this.exactCache.set(meta.id, cached);
      return cached;
    }

    const refs: InternalRecordRef[] = [];
    let offset = meta.byteStart;
    let lineStart = meta.byteStart;
    let previousByte: number | undefined;

    while (offset < meta.physicalEndExclusive) {
      guard();
      const remaining = meta.physicalEndExclusive - offset;
      const configuredReadBytes = Math.min(this.options.readChunkBytes, MAX_NEWLINE_SCAN_BYTES);
      const length = Number(remaining < BigInt(configuredReadBytes)
        ? remaining
        : BigInt(configuredReadBytes));
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
      guard();
      if (bytesRead <= 0) {
        throw new JsonlEngineError('UNEXPECTED_EOF', 'Unable to rebuild an exact JSONL segment.');
      }

      const chunk = buffer.subarray(0, bytesRead);
      const newlineOffsets = this.options.newlineScanner.scan(chunk);
      await this.options.validateSnapshot();
      guard();
      newlineOffsets.forEach((index) => {
        const absolute = offset + BigInt(index);
        const precedingByte = index === 0 ? previousByte : chunk[index - 1];
        const hasCarriageReturn = precedingByte === 0x0d;
        const contentEnd = hasCarriageReturn ? absolute - 1n : absolute;
        refs.push(this.makeRebuiltRef(
          meta.firstOrdinal + BigInt(refs.length),
          lineStart,
          contentEnd,
          hasCarriageReturn ? 2 : 1,
        ));
        lineStart = absolute + 1n;
      });
      previousByte = chunk[bytesRead - 1];
      offset += BigInt(bytesRead);
    }

    if (lineStart < meta.physicalEndExclusive) {
      refs.push(this.makeRebuiltRef(
        meta.firstOrdinal + BigInt(refs.length),
        lineStart,
        meta.physicalEndExclusive,
        0,
      ));
    }
    if (refs.length !== meta.recordCount) {
      throw new JsonlEngineError('SOURCE_CHANGED', 'A JSONL segment no longer matches its snapshot index.');
    }

    this.putCache(meta.id, refs);
    return refs;
  }

  private makeRebuiltRef(
    ordinal: bigint,
    byteStart: bigint,
    byteEndExclusive: bigint,
    delimiterByteLength: 0 | 1 | 2,
  ): InternalRecordRef {
    const contentByteLength = byteEndExclusive - byteStart;
    return {
      ordinal,
      byteStart,
      byteEndExclusive,
      contentByteLength,
      delimiterByteLength,
      parseState: contentByteLength > BigInt(this.options.maxRecordBytes) ? 'oversized' : 'unknown',
    };
  }

  private putCache(id: number, refs: InternalRecordRef[]): void {
    this.exactCache.delete(id);
    this.exactCache.set(id, refs);
    while (this.exactCache.size > this.options.exactCacheSegments) {
      const oldest = this.exactCache.keys().next().value as number | undefined;
      if (oldest === undefined) return;
      this.exactCache.delete(oldest);
    }
  }
}
