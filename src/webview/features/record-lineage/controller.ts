import type { DocumentSummary, ExtensionMessage, RecordRef, RowProjection } from '@shared/types';
import { LINEAGE_LOOKUP_RETAINED_ROWS, type LineageLookupRelation, type LineageLookupReply } from '@shared/contracts/lineage';
import { lineageLookupTarget, matchesLineageTarget } from '@shared/lineage-evidence';
import { sameGraphRecordRef } from '@shared/document-graph';
import type { VsCodeMessageClient } from '@webview/protocol-client';

export interface LineageLookupState {
  readonly status: 'idle' | 'loading' | 'settled' | 'cancelled' | 'error';
  readonly sourceRef?: RecordRef;
  readonly relation?: LineageLookupRelation;
  readonly reply?: LineageLookupReply;
  readonly extraRows: readonly RowProjection[];
}
interface Context { summary?: DocumentSummary | undefined; rows: readonly RowProjection[]; available: boolean }
interface Ports { client: VsCodeMessageClient; getContext(): Context; onChange(value: LineageLookupState): void }

/** Owns one correlated lookup. Cancellation keeps the promise's late result outside the UI. */
export class RecordLineageUiController {
  private value: LineageLookupState = { status: 'idle', extraRows: [] };
  private pending: { id: string; source: RowProjection; relation: LineageLookupRelation; context: Context; identity: string } | undefined;
  private receiptIdentity: string | undefined;
  private readonly ports: Ports;
  public constructor(ports: Ports) { this.ports = ports; }
  public get state(): LineageLookupState { return this.value; }
  public lookup(ref: RecordRef, relation: LineageLookupRelation): void {
    this.cancel();
    const context = this.ports.getContext();
    const source = [...context.rows, ...this.value.extraRows].find((row) => sameGraphRecordRef(row.ref, ref));
    if (!context.available || context.summary === undefined || source === undefined || lineageLookupTarget(source, relation) === undefined) return;
    const request = this.ports.client.send('LOOKUP_LINEAGE_RECORD', { sourceRef: ref, relation });
    this.pending = { id: request.id, source, relation, context, identity: identity(context.summary) };
    this.receiptIdentity = identity(context.summary);
    this.change({ status: 'loading', sourceRef: ref, relation, extraRows: this.value.extraRows });
  }
  public cancel(): void {
    this.ports.client.cancel('lineage'); this.pending = undefined;
    if (this.value.status === 'loading') this.change({ ...this.value, status: 'cancelled' });
  }
  public invalidate(): void { this.cancel(); this.receiptIdentity = undefined; this.change({ status: 'idle', extraRows: [] }); }
  public receive(message: ExtensionMessage): boolean {
    if ((message.type === 'OPENED' || message.type === 'INDEX_PROGRESS') && this.receiptIdentity !== undefined
      && identity(message.payload) !== this.receiptIdentity) { this.invalidate(); return false; }
    if (message.type === 'ROWS' || message.type === 'SOURCE_INVALIDATED' || message.type === 'PROFILE_CHANGED') { this.invalidate(); return false; }
    const pending = this.pending;
    if (pending === undefined || message.requestId !== pending.id) return message.type === 'LINEAGE_LOOKUP_RESULT';
    if (message.type !== 'LINEAGE_LOOKUP_RESULT' && message.type !== 'ERROR') return false;
    this.pending = undefined;
    const context = this.ports.getContext();
    if (!context.available || context.summary === undefined || context.rows !== pending.context.rows || identity(context.summary) !== pending.identity) {
      this.invalidate(); return true;
    }
    if (message.type === 'ERROR') { this.change({ ...this.value, status: 'error' }); return true; }
    const reply = message.payload;
    const summary = context.summary;
    const target = lineageLookupTarget(pending.source, pending.relation);
    if (!sameGraphRecordRef(reply.sourceRef, pending.source.ref) || reply.relation !== pending.relation
      || reply.profileId !== summary.profileId || reply.profileVersion !== summary.profileVersion || reply.profileEpoch !== summary.profileEpoch
      || (reply.match !== undefined && (target === undefined || !matchesLineageTarget(pending.source, reply.match, target)))) {
      this.change({ ...this.value, status: 'error' }); return true;
    }
    const extraRows = reply.match !== undefined
      && ![...context.rows, ...this.value.extraRows].some((row) => sameGraphRecordRef(row.ref, reply.match!.ref))
      ? [...this.value.extraRows, reply.match].slice(-LINEAGE_LOOKUP_RETAINED_ROWS) : this.value.extraRows;
    this.change({ status: 'settled', sourceRef: pending.source.ref, relation: pending.relation, reply, extraRows });
    return true;
  }
  private change(value: LineageLookupState): void { this.value = value; this.ports.onChange(value); }
}
function identity(summary: DocumentSummary): string {
  return JSON.stringify([summary.snapshot.documentId, summary.snapshot.generation, summary.snapshot.epoch,
    summary.profileId, summary.profileVersion, summary.profileEpoch]);
}
