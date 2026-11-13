import type { ExtensionMessage, RowPage } from '@shared/types';
import type { RevealAckPayload } from '@shared/contracts/reveal';
import type { ProtocolSession } from '@webview/protocol-client';

export type RevealMessage = Extract<ExtensionMessage, { type: 'REVEAL' }>;
export interface WebviewRevealPorts {
  readonly getSession: () => ProtocolSession;
  readonly isLocal: (message: RevealMessage) => boolean;
  readonly load: (ordinal: string) => string | undefined;
  readonly acknowledge: (message: RevealMessage, payload: RevealAckPayload) => void;
  readonly onChange: (target: RevealMessage | undefined) => void;
}

/** One current intent. Paging acceptance and DOM commit are distinct barriers. */
export class WebviewRevealController {
  readonly #ports: WebviewRevealPorts;
  #pending: { message: RevealMessage; rowsRequestId?: string } | undefined;
  #target: RevealMessage | undefined;

  public constructor(ports: WebviewRevealPorts) { this.#ports = ports; }
  public get target(): RevealMessage | undefined { return this.#target; }
  public get pending(): boolean { return this.#pending !== undefined; }

  public begin(message: RevealMessage): void {
    this.cancel();
    if (!this.isCurrent(message)) return;
    this.#pending = { message };
    if (this.#ports.isLocal(message)) { this.setTarget(message); return; }
    const rowsRequestId = this.#ports.load(message.payload.anchorOrdinal);
    if (rowsRequestId === undefined) { this.finish('stale'); return; }
    this.#pending = { message, rowsRequestId };
  }

  public rowsAccepted(requestId: string, page: RowPage): void {
    const pending = this.#pending;
    if (pending === undefined || pending.rowsRequestId !== requestId) return;
    if (!this.isCurrent(pending.message)) { this.invalidate(); return; }
    const ordinal = pending.message.payload.anchorOrdinal;
    if (page.rows.some((row) => row.ref.ordinal === ordinal && row.ref.generation === pending.message.generation)) {
      this.setTarget(pending.message); return;
    }
    const examinedTarget = page.scan?.truncatedReason !== 'uninspectable_record'
      && ((page.rows[0] !== undefined && BigInt(page.rows[0].ref.ordinal) > BigInt(ordinal))
        || (page.scan?.cursorOrdinal !== undefined && BigInt(page.scan.cursorOrdinal) >= BigInt(ordinal)));
    this.finish(examinedTarget ? 'filtered-out' : 'not-found');
  }

  public rendered(requestId: string, ordinal: string): void {
    const message = this.#target;
    if (message === undefined || message.requestId !== requestId || message.payload.anchorOrdinal !== ordinal) return;
    if (!this.isCurrent(message)) { this.invalidate(); return; }
    this.finish('shown');
  }

  public invalidate(): void { this.finish('stale'); }
  public requestFailed(requestId: string, code: string): void {
    if (this.#pending?.rowsRequestId === requestId
      || ['SOURCE_CHANGED', 'STALE_GENERATION', 'STALE_EPOCH'].includes(code)) this.invalidate();
  }
  public cancel(): void { this.#pending = undefined; this.setTarget(undefined); }

  private isCurrent(message: RevealMessage): boolean {
    const session = this.#ports.getSession();
    return session.documentId === message.documentId && session.generation === message.generation && session.epoch === message.epoch;
  }
  private setTarget(target: RevealMessage | undefined): void { this.#target = target; this.#ports.onChange(target); }
  private finish(outcome: RevealAckPayload['outcome']): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.cancel();
    this.#ports.acknowledge(pending.message, { anchorOrdinal: pending.message.payload.anchorOrdinal, outcome,
      ...(outcome === 'shown' ? { renderedOrdinal: pending.message.payload.anchorOrdinal } : {}) });
  }
}

interface Bounds { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; readonly width: number; readonly height: number }
/** DOM observation only: no claim about compositor completion or human attention. */
export function hasVisibleRevealTarget(viewport: Bounds, row: Bounds, hidden: boolean): boolean {
  return !hidden && viewport.width > 0 && viewport.height > 0 && row.width > 0 && row.height > 0
    && row.top < viewport.bottom && row.bottom > viewport.top && row.left < viewport.right && row.right > viewport.left;
}
