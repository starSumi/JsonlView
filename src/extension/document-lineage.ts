import type { IJsonlSessionPort } from '@application/ports/session';
import type { DocumentSummary, RecordRef, RowProjection } from '@shared/types';
import { lineageLookupWindow } from '@shared/lineage-lookup';
import { LINEAGE_LOOKUP_RETAINED_ROWS, type LineageLookupReply, type LineageLookupRequest } from '@shared/contracts/lineage';
import { isLineageLookupReply } from '@shared/transport/extension-message';
import { sameGraphRecordRef } from '@shared/document-graph';
import { lineageLookupTarget, matchesLineageTarget } from '@shared/lineage-evidence';

/** References are issued by accepted page delivery, never reconstructed from client offsets. */
export class DocumentLineageAuthority {
  private summary: DocumentSummary | undefined;
  private rows: readonly RowProjection[] = [];
  private lookupRows: readonly RowProjection[] = [];
  private revision = 0;
  private readonly session: IJsonlSessionPort;
  public constructor(session: IJsonlSessionPort) { this.session = session; }

  public invalidate(): void { this.revision += 1; this.summary = undefined; this.rows = []; this.lookupRows = []; }
  public acceptPage(summary: DocumentSummary, rows: readonly RowProjection[]): void {
    this.invalidate();
    this.summary = { ...summary, snapshot: { ...summary.snapshot } };
    this.rows = rows.slice(0, 500);
  }
  public async lookup(request: LineageLookupRequest, signal: AbortSignal): Promise<{
    reply: LineageLookupReply; isCurrent: () => boolean; publish: () => void;
  }> {
    const summary = this.summary;
    const revision = this.revision;
    const sources = [...this.rows, ...this.lookupRows].filter((row) => sameGraphRecordRef(row.ref, request.sourceRef));
    const source = sources.length === 1 ? sources[0] : undefined;
    if (summary === undefined || source === undefined || !sameLineageSummary(summary, this.session.getSummary())) {
      throw new Error('Lineage lookup requires an exact reference from the current delivered page.');
    }
    const target = lineageLookupTarget(source, request.relation);
    if (target === undefined) throw new Error('This record has no supported source-evidenced lookup target.');
    const window = lineageLookupWindow(source, request.relation);
    const isCurrent = (): boolean => !signal.aborted && revision === this.revision
      && sameLineageSummary(summary, this.session.getSummary());
    const reply: LineageLookupReply = this.session.lookupLineage === undefined ? {
      ...request, status: 'unavailable', profileId: summary.profileId, profileVersion: summary.profileVersion ?? '',
      ...(summary.profileEpoch === undefined ? {} : { profileEpoch: summary.profileEpoch }),
      scope: { kind: 'physical-window', startOrdinal: window.startOrdinal, endOrdinalExclusive: window.endOrdinalExclusive,
        examinedRecords: 0, examinedBytes: '0', requestedBytes: 0, complete: false },
    } : await this.session.lookupLineage(source, request.relation, signal);
    if (!isLineageLookupReply(reply, summary.snapshot.generation) || !sameGraphRecordRef(reply.sourceRef, source.ref)
      || reply.relation !== request.relation || reply.profileId !== summary.profileId
      || reply.profileVersion !== (summary.profileVersion ?? '') || reply.profileEpoch !== summary.profileEpoch
      || reply.scope.startOrdinal !== window.startOrdinal || reply.scope.endOrdinalExclusive !== window.endOrdinalExclusive
      || (reply.match !== undefined && !matchesLineageTarget(source, reply.match, target))) throw new Error('The lookup returned an invalid source relationship.');
    return { reply, isCurrent, publish: () => {
      if (isCurrent() && reply.match !== undefined
        && ![...this.rows, ...this.lookupRows].some((row) => sameGraphRecordRef(row.ref, reply.match!.ref))) {
        this.lookupRows = [...this.lookupRows, reply.match].slice(-LINEAGE_LOOKUP_RETAINED_ROWS);
      }
    } };
  }
}

export function sameLineageSummary(left: DocumentSummary, right: DocumentSummary): boolean {
  return left.snapshot.documentId === right.snapshot.documentId && left.snapshot.generation === right.snapshot.generation
    && left.snapshot.epoch === right.snapshot.epoch && left.profileId === right.profileId
    && left.profileVersion === right.profileVersion && left.profileEpoch === right.profileEpoch;
}
