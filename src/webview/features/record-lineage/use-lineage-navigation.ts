import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ExtensionMessage, RecordRef } from '@shared/types';
import { sameGraphRecordRef } from '@shared/document-graph';
import { snapshotIdentityChanged } from '@webview/snapshot-identity';
import { canReadSnapshot, type WorkspaceState } from '@webview/state';
import type { GridFocusBridge } from '@features/record-query/RecordTable';

export interface LineageNavigation {
  readonly history: readonly RecordRef[];
  readonly notice: string | undefined;
  isNavigating(): boolean;
  select(ref: RecordRef, locate?: boolean): void;
  back(): void;
  reset(): void;
  receive(message: ExtensionMessage): void;
}
interface Ports {
  state: WorkspaceState;
  getState(): WorkspaceState;
  getDocumentId(): string;
  requestDetail(ref: RecordRef, full?: boolean, select?: boolean): void;
  revealOrdinal(ordinal: string): string | undefined;
  showTable(): void;
  showTree(): void;
  gridFocusBridgeRef: RefObject<GridFocusBridge | undefined>;
}

/** Local detail history and table focus; Host request ownership stays in App. */
export function useLineageNavigation(ports: Ports): LineageNavigation {
  const [history, setHistory] = useState<readonly RecordRef[]>([]);
  const [notice, setNotice] = useState<string>();
  const navigating = useRef(false);
  const pageNavigation = useRef(false);
  const target = useRef<{ ref: RecordRef; requestId?: string } | undefined>(undefined);
  const latest = useRef(ports); latest.current = ports;
  const reset = useCallback((): void => { setHistory([]); setNotice(undefined); target.current = undefined; pageNavigation.current = false; }, []);
  const select = useCallback((ref: RecordRef, locate = false): void => {
    const p = latest.current; const state = p.getState();
    if (ref.generation !== state.summary?.snapshot.generation || !canReadSnapshot(state.invalidationReason)) return;
    if (state.selectedRef !== undefined && !sameGraphRecordRef(state.selectedRef, ref)) setHistory((items) => [...items.slice(-15), state.selectedRef!]);
    navigating.current = true;
    try {
      if (locate) {
        p.showTable();
        const local = state.rows.some((row) => sameGraphRecordRef(row.ref, ref));
        pageNavigation.current = !local;
        const requestId = local ? undefined : p.revealOrdinal(ref.ordinal);
        target.current = { ref, ...(requestId === undefined ? {} : { requestId }) };
        setNotice(local ? `Focusing record #${ref.ordinal}…` : `Looking for #${ref.ordinal} in the current query · physical ascending order…`);
      } else p.showTree();
      p.requestDetail(ref, false, true);
    } finally { navigating.current = false; }
  }, []);
  const back = (): void => {
    const ref = history.at(-1); if (ref === undefined) return;
    setHistory((items) => items.slice(0, -1)); navigating.current = true;
    try { latest.current.requestDetail(ref, false, true); } finally { navigating.current = false; }
  };
  useLayoutEffect(() => {
    const pending = target.current; const state = ports.state;
    if (pending === undefined || state.pending.rows) return;
    const row = state.rows.find((candidate) => sameGraphRecordRef(candidate.ref, pending.ref));
    if (row !== undefined) {
      const column = state.columns[0];
      const focused = column !== undefined && ports.gridFocusBridgeRef.current?.restore({ kind: 'data', sessionId: ports.getDocumentId(),
        generation: row.ref.generation, ordinal: row.ref.ordinal, columnId: column.id });
      if (!focused) return;
      target.current = undefined; setNotice(`Table focused on record #${pending.ref.ordinal}.`);
    } else if (pending.requestId === undefined) {
      target.current = undefined; setNotice(`Record #${pending.ref.ordinal} was not observed in this table page. The current filters were kept.`);
    }
  }, [ports]);
  const receive = (message: ExtensionMessage): void => {
    if (message.type === 'ROWS') { if (!pageNavigation.current) setHistory([]); pageNavigation.current = false; }
    const summary = latest.current.getState().summary;
    if (message.type === 'SOURCE_INVALIDATED' || message.type === 'PROFILE_CHANGED'
      || ((message.type === 'OPENED' || message.type === 'INDEX_PROGRESS') && summary !== undefined
        && (snapshotIdentityChanged(summary.snapshot, message.payload.snapshot) || summary.profileId !== message.payload.profileId
          || summary.profileVersion !== message.payload.profileVersion || summary.profileEpoch !== message.payload.profileEpoch))) reset();
    if ((message.type === 'ROWS' || message.type === 'ERROR') && target.current?.requestId === message.requestId) {
      target.current = { ref: target.current.ref };
    }
  };
  return { history, notice, isNavigating: () => navigating.current, select, back, reset, receive };
}
