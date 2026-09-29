import React from 'react';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { formatBytes } from './format';

export interface WorkspaceHeaderProps {
  children: React.ReactNode;
  indexedBytes: string;
  sizeBytes: string;
  indexedRecords: string;
  validRecords: string;
  problemRecords: string;
  complete: boolean;
  phase: string;
  appendPending: boolean;
  rebuildBusy: boolean;
  onRebuild: () => void;
}

export function WorkspaceHeader({ children, ...status }: WorkspaceHeaderProps): React.JSX.Element {
  const indexed = Number(status.indexedBytes);
  const size = Number(status.sizeBytes);
  const progress = size > 0 && Number.isFinite(indexed) ? Math.min(100, (indexed / size) * 100) : 0;

  return (
    <header className="workspace-header" aria-label="Workspace controls and status">
      <div className="toolbar">{children}</div>
      <div className="status-strip" role="status" aria-live="polite">
        <span className="status-metric status-records">{status.indexedRecords} rows</span>
        <span className="status-metric status-bytes">{formatBytes(status.indexedBytes)} / {formatBytes(status.sizeBytes)}</span>
        <span className="status-metric status-valid"><Check size={13} aria-hidden />{status.validRecords}</span>
        <span
          className={`status-metric status-problems${status.problemRecords === '0' ? '' : ' status-problem'}`}
          data-empty={status.problemRecords === '0'}
          title="Problem records observed during hydration for this document generation; this is not a complete-file total"
          aria-label={`${status.problemRecords} problem records observed during hydration; not a complete-file total`}
        >
          <CircleAlert size={13} aria-hidden />
          <span>{status.problemRecords}</span>
          <span className="status-scope">{status.problemRecords === '1' ? 'record' : 'records'} observed</span>
        </span>
        {status.appendPending ? (
          <span className="snapshot-update" title="The current snapshot remains readable; rebuild to include appended records.">
            <span className="snapshot-update-label">Update pending</span>
            <span className="snapshot-update-compact">Pending</span>
            <button type="button" disabled={status.rebuildBusy} onClick={status.onRebuild}>Rebuild</button>
          </span>
        ) : null}
        <span className="status-phase" data-complete={status.complete}>
          {!status.complete ? <LoaderCircle size={13} className="spin" aria-hidden /> : null}
          {status.phase}
        </span>
        <span className="progress-track" aria-label={`${progress.toFixed(0)}% indexed`}>
          <span style={{ width: `${progress}%` }} />
        </span>
      </div>
    </header>
  );
}
