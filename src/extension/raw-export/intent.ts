import { createHash, randomUUID } from 'node:crypto';
import type { DocumentSummary, Predicate, RecordRef } from '@shared/types';
import { isValidQueryPredicate } from '../message-validation';

/** Host-only full-record scope. This is not a Webview request or a projected format. */
export type RawExportSelection =
  | { readonly kind: 'selected-records'; readonly refs: readonly RecordRef[] }
  | { readonly kind: 'ordinal-range'; readonly first: string; readonly last: string }
  | { readonly kind: 'matching'; readonly predicate?: Predicate };

export interface RawExportIntent {
  readonly schema: 'jsonlview.raw-export-operation.v1';
  readonly requestId: string;
  readonly selectionDigest: string;
  readonly binding: {
    readonly documentId: string; readonly generation: string; readonly epoch: number;
    readonly uri: string; readonly sizeBytes: string; readonly mtimeMs: number; readonly prefixFingerprint: string;
    readonly device?: string; readonly inode?: string;
    readonly profileId: string; readonly profileVersion: string; readonly profileEpoch: number;
  };
  readonly selection: RawExportSelection;
}

export const isExportOrdinal = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 20 && /^(?:0|[1-9]\d*)$/u.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
export const isExportRequestId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);

export function captureRawExportIntent(summary: DocumentSummary, selection: RawExportSelection, requestId: string = randomUUID()): RawExportIntent {
  if (!isExportRequestId(requestId) || !isExportOrdinal(summary.snapshot.sizeBytes)) throw new Error('Invalid export identity.');
  const snapshot = summary.snapshot;
  const binding: RawExportIntent['binding'] = {
    documentId: snapshot.documentId, generation: snapshot.generation, epoch: snapshot.epoch ?? 0,
    uri: snapshot.uri, sizeBytes: snapshot.sizeBytes, mtimeMs: snapshot.mtimeMs, prefixFingerprint: snapshot.prefixFingerprint,
    ...(snapshot.device === undefined ? {} : { device: snapshot.device }),
    ...(snapshot.inode === undefined ? {} : { inode: snapshot.inode }), profileId: summary.profileId,
    profileVersion: summary.profileVersion ?? '', profileEpoch: summary.profileEpoch ?? 0,
  };
  const normalized = normalizeSelection(selection, binding.generation, BigInt(binding.sizeBytes));
  const selectionDigest = 'sha256:' + createHash('sha256').update(canonical({ binding, selection: normalized })).digest('hex');
  return freeze({ schema: 'jsonlview.raw-export-operation.v1', requestId, selectionDigest, binding, selection: normalized });
}

export function rawExportIntentIsCurrent(intent: RawExportIntent, summary: DocumentSummary): boolean {
  try { return captureRawExportIntent(summary, intent.selection, intent.requestId).selectionDigest === intent.selectionDigest; }
  catch { return false; }
}

export function isRawExportIntent(value: unknown): value is RawExportIntent {
  try {
    if (value === null || typeof value !== 'object') return false;
    const intent = value as RawExportIntent;
    const binding = intent.binding;
    if (intent.schema !== 'jsonlview.raw-export-operation.v1' || binding === null || typeof binding !== 'object'
      || ![binding.documentId, binding.generation, binding.profileId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)
      || typeof binding.profileVersion !== 'string' || binding.profileVersion.length > 256
      || typeof binding.uri !== 'string' || binding.uri.length > 32768 || !Number.isFinite(binding.mtimeMs)
      || typeof binding.prefixFingerprint !== 'string' || binding.prefixFingerprint.length > 256
      || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0 || !Number.isSafeInteger(binding.profileEpoch) || binding.profileEpoch < 0
      || [binding.device, binding.inode].some((part) => part !== undefined && (typeof part !== 'string' || !/^\d{1,64}$/u.test(part)))) return false;
    const summary = { snapshot: { documentId: binding.documentId, generation: binding.generation, epoch: binding.epoch,
      sizeBytes: binding.sizeBytes, uri: binding.uri, mtimeMs: binding.mtimeMs, prefixFingerprint: binding.prefixFingerprint,
      device: binding.device, inode: binding.inode }, profileId: binding.profileId,
      profileVersion: binding.profileVersion, profileEpoch: binding.profileEpoch } as DocumentSummary;
    return captureRawExportIntent(summary, intent.selection, intent.requestId).selectionDigest === intent.selectionDigest;
  } catch { return false; }
}

function normalizeSelection(selection: RawExportSelection, generation: string, size: bigint): RawExportSelection {
  if (selection.kind === 'ordinal-range') {
    if (!isExportOrdinal(selection.first) || !isExportOrdinal(selection.last) || BigInt(selection.first) > BigInt(selection.last)) {
      throw new Error('Invalid export selection.');
    }
    return { kind: selection.kind, first: selection.first, last: selection.last };
  }
  if (selection.kind === 'selected-records') {
    if (selection.refs.length === 0 || selection.refs.length > 4096) throw new Error('Invalid export selection.');
    const refs = new Map<string, RecordRef>();
    for (const ref of selection.refs) {
      if (ref.generation !== generation || !isExportOrdinal(ref.ordinal) || !isExportOrdinal(ref.byteStart)
        || !isExportOrdinal(ref.byteEndExclusive) || !isExportOrdinal(ref.contentByteLength)
        || ![0, 1, 2].includes(ref.delimiterByteLength)
        || BigInt(ref.byteEndExclusive) + BigInt(ref.delimiterByteLength) > size
        || BigInt(ref.contentByteLength) + BigInt(ref.delimiterByteLength) === 0n
        || BigInt(ref.byteEndExclusive) - BigInt(ref.byteStart) !== BigInt(ref.contentByteLength)) {
        throw new Error('Invalid export selection.');
      }
      const copy: RecordRef = { generation, ordinal: ref.ordinal, byteStart: ref.byteStart, byteEndExclusive: ref.byteEndExclusive,
        contentByteLength: ref.contentByteLength, delimiterByteLength: ref.delimiterByteLength, parseState: 'unknown' };
      const previous = refs.get(ref.ordinal);
      if (previous !== undefined && canonical(previous) !== canonical(copy)) throw new Error('Conflicting export selection.');
      refs.set(ref.ordinal, copy);
    }
    return { kind: selection.kind, refs: [...refs.values()].sort((a, b) => BigInt(a.ordinal) < BigInt(b.ordinal) ? -1 : 1) };
  }
  if (selection.kind !== 'matching') throw new Error('Invalid export selection.');
  if (selection.predicate !== undefined && !isValidQueryPredicate(selection.predicate)) throw new Error('Invalid export predicate.');
  const encoded = JSON.stringify(selection.predicate);
  if (encoded !== undefined && encoded.length > 32768) throw new Error('Invalid export predicate.');
  return selection.predicate === undefined ? { kind: 'matching' } : { kind: 'matching', predicate: JSON.parse(encoded!) as Predicate };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map((key) => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
