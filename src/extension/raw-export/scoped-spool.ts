import { createHash } from 'node:crypto';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import type { RecordRef } from '@shared/types';
import type { RawExportIntent } from './intent';
import { observeRawExportSource, sameRawExportObservation, type RawExportSourceObservation } from './source-observation';

export interface ScopedRawExportLimits { maxExaminedBytes: number; maxExaminedRecords: number; maxOutputBytes: number; deadlineMs: number }
export const SCOPED_RAW_EXPORT_LIMITS: Readonly<ScopedRawExportLimits> = Object.freeze({ maxExaminedBytes: 256 * 1024 * 1024,
  maxExaminedRecords: 1_000_000, maxOutputBytes: 64 * 1024 * 1024, deadlineMs: 30_000 });
const CHUNK_BYTES = 64 * 1024;
const MAX_PREDICATE_RECORD_BYTES = 1024 * 1024;

export interface ScopedRawSpoolRequest {
  readonly sourcePath: string;
  readonly spoolPath: string;
  readonly intent: RawExportIntent;
  /** Rechecks the captured document, source observation, profile and open-document grant. */
  readonly authorize: () => Promise<boolean>;
  /** Captured profile projection plus the existing engine predicate evaluator. */
  readonly matches?: (value: unknown, ref: RecordRef) => boolean;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<ScopedRawExportLimits>;
  readonly sourceObservation?: RawExportSourceObservation;
}

export interface ScopedRawSpoolResult {
  readonly byteLength: string;
  readonly sha256: string;
  readonly records: string;
  readonly examinedRecords: string;
  readonly examinedBytes: string;
}

/** One forward physical scan. No page cursor, sort window, lossy text or source writes. */
export async function createScopedRawSpool(request: ScopedRawSpoolRequest): Promise<ScopedRawSpoolResult> {
  const limits = { ...SCOPED_RAW_EXPORT_LIMITS };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = request.limits?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 0 || value > limits[key]) throw new Error('Invalid export budget.');
      limits[key] = value;
    }
  }
  const deadline = Date.now() + limits.deadlineMs;
  const guard = (): void => {
    if (request.signal?.aborted) throw new Error('Export cancelled.');
    if (Date.now() >= deadline) throw new Error('Export deadline exhausted.');
  };
  guard();
  if (!await request.authorize()) throw new Error('Export authorization changed.');
  if (request.sourceObservation !== undefined && !sameRawExportObservation(request.sourceObservation,
    await observeRawExportSource(request.sourcePath, request.intent))) throw new Error('Export source observation changed.');
  const source = await open(request.sourcePath, 'r');
  let output: FileHandle | undefined;
  try {
    const before = await source.stat({ bigint: true });
    const pathBefore = await lstat(request.sourcePath, { bigint: true });
    const binding = request.intent.binding;
    if (!before.isFile() || pathBefore.isSymbolicLink() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || before.size.toString() !== binding.sizeBytes
      || (binding.device !== undefined && binding.device !== before.dev.toString())
      || (binding.inode !== undefined && binding.inode !== before.ino.toString())) throw new Error('Export source changed.');
    output = await open(request.spoolPath, 'wx', 0o600);
    const digest = createHash('sha256');
    const selection = request.intent.selection;
    const selected = selection.kind === 'selected-records' ? new Map(selection.refs.map((ref) => [ref.ordinal, ref])) : undefined;
    const finalOrdinal = selection.kind === 'ordinal-range' ? BigInt(selection.last)
      : selection.kind === 'selected-records' ? BigInt(selection.refs[selection.refs.length - 1]!.ordinal) : undefined;
    let outputBytes = 0;
    let outputRecords = 0;
    let examinedRecords = 0;
    let position = 0;
    let recordStart = 0;
    let parts: Buffer[] = [];
    let partBytes = 0;
    let finished = false;

    const consume = async (record: Buffer): Promise<void> => {
      guard();
      if (++examinedRecords > limits.maxExaminedRecords) throw new Error('Export record budget exhausted.');
      const ordinal = BigInt(examinedRecords - 1);
      const delimiter = record[record.length - 1] === 10 ? (record[record.length - 2] === 13 ? 2 : 1) : 0;
      const ref: RecordRef = { generation: binding.generation, ordinal: ordinal.toString(), byteStart: String(recordStart),
        byteEndExclusive: String(recordStart + record.length - delimiter), contentByteLength: String(record.length - delimiter),
        delimiterByteLength: delimiter, parseState: 'unknown' };
      recordStart += record.length;
      let include = selection.kind === 'ordinal-range' ? ordinal >= BigInt(selection.first) && ordinal <= BigInt(selection.last)
        : selection.kind === 'selected-records' ? selected!.has(ref.ordinal) : selection.predicate === undefined;
      if (include && selected !== undefined) {
        const expected = selected.get(ref.ordinal)!;
        if (expected.byteStart !== ref.byteStart || expected.byteEndExclusive !== ref.byteEndExclusive
          || expected.contentByteLength !== ref.contentByteLength || expected.delimiterByteLength !== ref.delimiterByteLength) {
          throw new Error('Export selection coordinates changed.');
        }
      }
      if (selection.kind === 'matching' && selection.predicate !== undefined) {
        if (record.length - delimiter > MAX_PREDICATE_RECORD_BYTES) throw new Error('Export predicate record is uninspectable.');
        if (request.matches === undefined) throw new Error('Export predicate evaluator unavailable.');
        let parsed: unknown;
        let valid = false;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(0, record.length - delimiter))) as unknown; valid = true; }
        catch { /* Invalid/blank records do not match an active predicate, as in GET_ROWS. */ }
        include = valid && request.matches(parsed, ref);
      }
      if (include) {
        if (outputBytes + record.length > limits.maxOutputBytes) throw new Error('Export output budget exhausted.');
        let written = 0;
        while (written < record.length) {
          guard();
          const result = await output!.write(record, written, record.length - written, outputBytes + written);
          if (result.bytesWritten <= 0) throw new Error('Export spool write failed.');
          written += result.bytesWritten;
        }
        outputBytes += record.length;
        outputRecords++;
        digest.update(record);
      }
      if (finalOrdinal !== undefined && ordinal === finalOrdinal) finished = true;
    };

    while (!finished && position < Number(before.size)) {
      guard();
      const remaining = Math.min(CHUNK_BYTES, Number(before.size) - position, limits.maxExaminedBytes - position);
      if (remaining <= 0) throw new Error('Export scan byte budget exhausted.');
      const buffer = Buffer.allocUnsafe(remaining);
      const { bytesRead } = await source.read(buffer, 0, remaining, position);
      guard();
      if (bytesRead === 0) throw new Error('Export source changed.');
      position += bytesRead;
      let offset = 0;
      while (!finished && offset < bytesRead) {
        const lf = buffer.subarray(0, bytesRead).indexOf(10, offset);
        const end = lf < 0 ? bytesRead : lf + 1;
        const part = buffer.subarray(offset, end);
        parts.push(part);
        partBytes += part.length;
        if (partBytes > SCOPED_RAW_EXPORT_LIMITS.maxOutputBytes) throw new Error('Export record is uninspectable.');
        if (lf >= 0) { await consume(Buffer.concat(parts, partBytes)); parts = []; partBytes = 0; }
        offset = end;
      }
    }
    if (!finished && partBytes > 0) await consume(Buffer.concat(parts, partBytes));
    if (finalOrdinal !== undefined && !finished) throw new Error('Export selection is out of range.');
    guard();
    const after = await source.stat({ bigint: true });
    const pathAfter = await lstat(request.sourcePath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || pathAfter.isSymbolicLink() || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino
      || after.size !== pathAfter.size || after.mtimeNs !== pathAfter.mtimeNs || after.ctimeNs !== pathAfter.ctimeNs) {
      throw new Error('Export source changed.');
    }
    if (!await request.authorize()) throw new Error('Export authorization changed.');
    if (request.sourceObservation !== undefined && !sameRawExportObservation(request.sourceObservation,
      await observeRawExportSource(request.sourcePath, request.intent))) throw new Error('Export source observation changed.');
    guard();
    await output.sync();
    return { byteLength: String(outputBytes), sha256: 'sha256:' + digest.digest('hex'), records: String(outputRecords),
      examinedRecords: String(examinedRecords), examinedBytes: String(position) };
  } finally { await output?.close(); await source.close(); }
}
