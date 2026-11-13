import { projectDocumentGraph } from '@application/document-graph';
import { JsonlEngineError } from '@engine/index';
import { sameGraphRecordRef } from '@shared/document-graph';
import type { DocumentGraphReply, GraphRevealRequest } from '@shared/contracts/document-graph';
import type { DocumentSummary, RecordRef, RowPage } from '@shared/types';
import type { RevealRowTarget } from '@shared/protocol/reveal';
import { summaryIdentityMatches } from './summary-identity';

export interface DocumentGraphSession {
  getSummary(): DocumentSummary;
  getGraphRows(signal: AbortSignal): Promise<RowPage>;
  validateObservedSource(signal?: AbortSignal): Promise<boolean>;
}
interface Candidate { requestId: string; summary: DocumentSummary; reply: DocumentGraphReply; revision: number }
interface IssuedRecord { ref: RecordRef; target: RevealRowTarget }

/** One current Host-owned prefix and at most 100 physical reveal capabilities. */
export class DocumentGraphController {
  private readonly session: DocumentGraphSession;
  private readonly authorized: () => boolean;
  private revision = 0;
  private candidate: Candidate | undefined;
  private issued: Candidate | undefined;
  private readonly refs = new Map<string, IssuedRecord>();
  private active: AbortController | undefined;
  public constructor(session: DocumentGraphSession, authorized: () => boolean) { this.session = session; this.authorized = authorized; }

  public invalidate(): void {
    this.revision += 1; this.active?.abort(); this.active = undefined;
    this.candidate = undefined; this.issued = undefined; this.refs.clear();
  }

  public async load(requestId: string, signal: AbortSignal): Promise<DocumentGraphReply> {
    this.invalidate();
    const revision = this.revision;
    const summary = this.session.getSummary();
    const controller = new AbortController(); this.active = controller;
    const cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    try {
      if (!this.authorized()) return this.empty(summary, 'unauthorized', revision);
      if (controller.signal.aborted || !await this.session.validateObservedSource(controller.signal)) return this.empty(summary, 'stale', revision);
      const page = await this.session.getGraphRows(controller.signal);
      if (controller.signal.aborted || revision !== this.revision || !summaryIdentityMatches(summary, this.session.getSummary())) return this.empty(summary, 'stale', revision);
      if (!this.authorized()) return this.empty(summary, 'unauthorized', revision);
      if (!await this.session.validateObservedSource(controller.signal)) return this.empty(summary, 'stale', revision);
      if (controller.signal.aborted || !this.current(summary, revision)) return this.empty(summary, 'stale', revision);
      const reply = projectDocumentGraph(summary, page, String(revision));
      this.candidate = { requestId, summary, reply, revision };
      return reply;
    } catch (error) {
      const stale = controller.signal.aborted || (error instanceof JsonlEngineError && error.code === 'SOURCE_CHANGED');
      return this.empty(summary, stale ? 'stale' : 'unavailable', revision);
    } finally {
      signal.removeEventListener('abort', cancel);
      if (this.active === controller) this.active = undefined;
    }
  }

  /** Called only after the current reply was accepted by the Host message channel. */
  public publish(requestId: string, reply: DocumentGraphReply): boolean {
    const candidate = this.candidate;
    if (candidate === undefined || candidate.requestId !== requestId || candidate.reply !== reply
      || !this.current(candidate.summary, candidate.revision)) return false;
    this.issued = candidate; this.refs.clear();
    for (const node of reply.graph.snapshot.nodes) {
      if (node.recordRef === undefined) continue;
      this.refs.set(node.recordRef.ordinal, { ref: node.recordRef,
        target: { sourceId: node.qualifiedRef.sourceId, nativeId: node.qualifiedRef.nativeId, anchorOrdinal: node.recordRef.ordinal } });
    }
    return true;
  }

  public async resolve(request: GraphRevealRequest): Promise<{ target: RevealRowTarget; isCurrent: () => boolean } | undefined> {
    const issued = this.issued;
    const record = this.refs.get(request.ref.ordinal);
    if (issued === undefined || record === undefined || request.graphRequestId !== issued.requestId
      || !sameGraphRecordRef(record.ref, request.ref) || !this.current(issued.summary, issued.revision)) return undefined;
    let valid = false;
    try { valid = await this.session.validateObservedSource(); } catch { /* Fail closed on an unobservable source. */ }
    if (this.issued !== issued) return undefined;
    if (!valid || !this.current(issued.summary, issued.revision)) { this.invalidate(); return undefined; }
    return { target: record.target, isCurrent: () => this.issued === issued && this.current(issued.summary, issued.revision) };
  }

  private current(summary: DocumentSummary, revision: number): boolean {
    return this.revision === revision && this.authorized() && summaryIdentityMatches(summary, this.session.getSummary());
  }
  private empty(summary: DocumentSummary, status: 'stale' | 'unauthorized' | 'unavailable', revision: number): DocumentGraphReply {
    const reply = projectDocumentGraph(summary, { rows: [], columns: [], anchorOrdinal: '0', hasBefore: false,
      hasAfter: false, indexedRecords: '0', totalRecords: '0' }, String(revision));
    return { ...reply, status };
  }
}
