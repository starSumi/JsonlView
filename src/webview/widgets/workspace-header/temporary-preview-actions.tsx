import type { TemporaryPreviewStatus } from '@shared/types';
import { FileClock, SaveCheck, SavePlus } from 'lucide-react';

export function TemporaryPreviewBadge({ status }: { status: TemporaryPreviewStatus }): React.JSX.Element {
  return <span className="temporary-preview-badge" role="status" title="Recover this temporary source from Recent Previews during this VS Code session. Save As keeps a permanent copy.">
      <FileClock size={14} aria-hidden />
      Temporary{status.savedCopy ? ' · copy saved' : ''}
  </span>;
}

export function TemporaryPreviewSaveAction({ status, onSaveAs }: { status: TemporaryPreviewStatus; onSaveAs: () => void }): React.JSX.Element {
  return <button type="button" className="preview-save-action" onClick={onSaveAs} disabled={status.status === 'saving'}
      aria-label={status.status === 'saving' ? 'Saving…' : 'Save As…'}
      title="Save an exact copy to a new local file. The original preview remains temporary.">
      {status.savedCopy && status.status !== 'saving' ? <SaveCheck size={14} aria-hidden /> : <SavePlus size={14} aria-hidden />}
      <span className="toolbar-action-label">{status.status === 'saving' ? 'Saving…' : 'Save As…'}</span>
  </button>;
}

export function TemporaryPreviewActions({ status, onSaveAs }: { status: TemporaryPreviewStatus; onSaveAs: () => void }): React.JSX.Element {
  return <>
    <TemporaryPreviewBadge status={status} />
    <TemporaryPreviewSaveAction status={status} onSaveAs={onSaveAs} />
  </>;
}
