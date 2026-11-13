import type { ExtensionMessage, DocumentSummary } from '@shared/types';
import type { GraphNodeV2 } from '@shared/contracts/graph';
import { sameGraphRecordRef } from '@shared/document-graph';
import type { GraphRevealRequest } from '@shared/contracts/document-graph';
import type { VsCodeMessageClient } from '@webview/protocol-client';
import type { GraphViewState } from './GraphView';

interface GraphUiPorts {
  client: VsCodeMessageClient;
  getSummary(): DocumentSummary | undefined;
  canRead(): boolean;
  onChange(state: GraphViewState): void;
}
/** Current-reply correlation and source/profile revocation, separate from rendering. */
export class DocumentGraphUiController {
  private readonly ports: GraphUiPorts;
  private value: GraphViewState = { status: 'idle' };
  private summary: DocumentSummary | undefined;
  private pendingGraph: string | undefined;
  private pendingReveal: (GraphRevealRequest & { requestId: string }) | undefined;
  public constructor(ports: GraphUiPorts) { this.ports = ports; }
  public get state(): GraphViewState { return this.value; }

  public refresh(): void {
    this.invalidate('loading');
    const summary = this.ports.getSummary();
    if (!this.ports.canRead() || summary?.profileVersion === undefined) { this.change({ status: 'stale' }); return; }
    this.summary = summary;
    this.pendingGraph = this.ports.client.send('GET_GRAPH', {}).id;
  }
  public invalidate(status: GraphViewState['status'] = 'stale'): void {
    this.ports.client.cancel('graph'); this.ports.client.cancel('graphReveal');
    this.pendingGraph = undefined; this.pendingReveal = undefined; this.summary = undefined;
    this.change({ status });
  }
  public select(node: GraphNodeV2): void {
    if (this.value.reply?.graph.snapshot.nodes.includes(node)) this.change({ ...this.value, selectedId: node.nodeId });
  }
  public reveal(node: GraphNodeV2): void {
    if (!this.isCurrent() || node.recordRef === undefined || this.value.requestId === undefined
      || !this.value.reply?.graph.snapshot.nodes.includes(node)) return;
    this.select(node);
    this.ports.client.cancel('graphReveal');
    const payload = { graphRequestId: this.value.requestId, ref: node.recordRef };
    this.pendingReveal = { ...payload, requestId: this.ports.client.send('REVEAL_GRAPH_RECORD', payload).id };
    this.change({ ...this.value, revealStatus: `Locating physical record #${node.recordRef.ordinal}…` });
  }
  public receive(message: ExtensionMessage): void {
    if (message.type === 'SOURCE_INVALIDATED') { this.invalidate('stale'); return; }
    if (message.type === 'PROFILE_CHANGED') { this.invalidate('idle'); return; }
    if (message.type === 'OPENED' || message.type === 'INDEX_PROGRESS') {
      if (this.summary !== undefined && !sameIdentity(this.summary, message.payload)) this.invalidate('idle');
      return;
    }
    if (message.type === 'GRAPH' && message.requestId === this.pendingGraph) {
      this.pendingGraph = undefined;
      if (!this.isCurrent() || message.payload.profileId !== this.summary?.profileId
        || message.payload.profileVersion !== this.summary.profileVersion || message.payload.profileEpoch !== this.summary.profileEpoch) {
        this.invalidate('stale'); return;
      }
      this.change({ status: message.payload.status, reply: message.payload, requestId: message.requestId });
    } else if (message.type === 'GRAPH_REVEAL_RESULT') {
      const pending = this.pendingReveal;
      if (pending === undefined || message.requestId !== pending.requestId || message.payload.graphRequestId !== pending.graphRequestId
        || !sameGraphRecordRef(message.payload.ref, pending.ref) || !this.isCurrent()) return;
      this.pendingReveal = undefined;
      const outcome = message.payload.outcome;
      if (outcome === 'stale' || outcome === 'unauthorized') {
        this.invalidate(outcome); this.change({ ...this.value, revealStatus: `Graph reveal: ${outcome}. Refresh the current source.` });
      } else this.change({ ...this.value, revealStatus: `Graph reveal #${pending.ref.ordinal}: ${outcome}.` });
    } else if (message.type === 'ERROR' && (message.requestId === this.pendingGraph || message.requestId === this.pendingReveal?.requestId)) {
      this.invalidate('unavailable');
    }
  }
  private isCurrent(): boolean {
    const summary = this.ports.getSummary();
    return this.summary !== undefined && summary !== undefined && this.ports.canRead() && sameIdentity(this.summary, summary);
  }
  private change(value: GraphViewState): void { this.value = value; this.ports.onChange(value); }
}

function sameIdentity(left: DocumentSummary, right: DocumentSummary): boolean {
  return left.snapshot.documentId === right.snapshot.documentId && left.snapshot.generation === right.snapshot.generation
    && left.snapshot.epoch === right.snapshot.epoch && left.profileId === right.profileId
    && left.profileVersion === right.profileVersion && left.profileEpoch === right.profileEpoch;
}
