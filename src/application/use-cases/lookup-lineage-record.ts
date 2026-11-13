import type { DocumentSummary, RowPage, RowProjection } from '@shared/types';
import { lineageLookupTarget, matchesLineageTarget } from '@shared/lineage-evidence';
import { LINEAGE_LOOKUP_DEADLINE_MS, lineageLookupWindow } from '@shared/lineage-lookup';
import type { LineageLookupRelation, LineageLookupReply } from '@shared/contracts/lineage';

export interface LineageReadProgress { requestedBytes: number; examinedRecords: number; examinedBytes: string }
export interface LineageWindowReader {
  read(startOrdinal: string, records: number, deadline: number, signal: AbortSignal, progress: LineageReadProgress): Promise<RowPage>;
}

/** One explicit physical window. A unique match means unique only in this window. */
export async function lookupLineageRecord(summary: DocumentSummary, source: RowProjection, relation: LineageLookupRelation,
  reader: LineageWindowReader, signal: AbortSignal): Promise<LineageLookupReply> {
  const window = lineageLookupWindow(source, relation);
  const start = BigInt(window.startOrdinal); const count = window.recordLimit;
  const progress: LineageReadProgress = { requestedBytes: 0, examinedRecords: 0, examinedBytes: '0' };
  const base = {
    sourceRef: source.ref, relation, profileId: summary.profileId, profileVersion: summary.profileVersion ?? '',
    ...(summary.profileEpoch === undefined ? {} : { profileEpoch: summary.profileEpoch }),
  };
  const scope = (complete: boolean): LineageLookupReply['scope'] => ({ kind: 'physical-window', startOrdinal: String(start),
    endOrdinalExclusive: String(start + BigInt(count)), ...progress, complete });
  const target = lineageLookupTarget(source, relation);
  if (target === undefined || source.ref.generation !== summary.snapshot.generation || source.profile?.profileId !== summary.profileId) {
    return { ...base, status: 'unavailable', scope: scope(false) };
  }
  if (signal.aborted) throw new Error('Lineage lookup was cancelled.');
  if (count === 0) return { ...base, status: 'not-observed', scope: scope(true) };
  const deadline = Date.now() + LINEAGE_LOOKUP_DEADLINE_MS;
  try {
    const page = await reader.read(String(start), count, deadline, signal, progress);
    if (signal.aborted) throw new Error('Lineage lookup was cancelled.');
    if (Date.now() >= deadline) return { ...base, status: 'timed-out', scope: scope(false) };
    const reason = page.scan?.truncatedReason;
    const complete = reason === undefined || (reason === 'record_limit' && progress.examinedRecords === count);
    if (!complete) return { ...base, status: reason === 'time_limit' ? 'timed-out' : 'budget-exceeded', scope: scope(false) };
    const matches = page.rows.filter((row) => BigInt(row.ref.ordinal) >= start && BigInt(row.ref.ordinal) < start + BigInt(count)
      && matchesLineageTarget(source, row, target));
    return { ...base, status: matches.length > 1 ? 'ambiguous' : matches.length === 1 ? 'found' : 'not-observed', scope: scope(true),
      ...(matches.length === 1 ? { match: matches[0]! } : {}) };
  } catch (error) {
    if (signal.aborted) throw error;
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const status = code === 'SOURCE_CHANGED' || code === 'STALE_GENERATION' ? 'stale'
      : Date.now() >= deadline ? 'timed-out' : code === 'READ_BUDGET_EXCEEDED' ? 'budget-exceeded' : 'unavailable';
    return { ...base, status, scope: scope(false) };
  }
}
