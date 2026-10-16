import type { TemporaryPreviewStatus } from '../shared/types';

export function TemporaryPreviewActions({ status, onSaveAs }: { status: TemporaryPreviewStatus; onSaveAs: () => void }): React.JSX.Element {
  return <>
    <span className="temporary-preview-badge" role="status" title="Recover this temporary source from Recent Previews during this VS Code session. Save As keeps a permanent copy.">
      Temporary{status.savedCopy ? ' · copy saved' : ''}
    </span>
    <button type="button" onClick={onSaveAs} disabled={status.status === 'saving'}
      title="Save an exact copy to a new local file. The original preview remains temporary.">
      {status.status === 'saving' ? 'Saving…' : 'Save As…'}
    </button>
  </>;
}
