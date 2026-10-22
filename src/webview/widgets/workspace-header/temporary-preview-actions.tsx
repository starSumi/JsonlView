import type { TemporaryPreviewStatus } from '@shared/types';
import { Save } from 'lucide-react';

export function TemporaryPreviewActions({ status, onSaveAs }: { status: TemporaryPreviewStatus; onSaveAs: () => void }): React.JSX.Element {
  return <>
    <span className="temporary-preview-badge" role="status" title="Recover this temporary source from Recent Previews during this VS Code session. Save As keeps a permanent copy.">
      Temporary{status.savedCopy ? ' · copy saved' : ''}
    </span>
    <button type="button" className="preview-save-action" onClick={onSaveAs} disabled={status.status === 'saving'}
      aria-label={status.status === 'saving' ? 'Saving…' : 'Save As…'}
      title="Save an exact copy to a new local file. The original preview remains temporary.">
      <Save size={14} aria-hidden /><span className="toolbar-action-label">{status.status === 'saving' ? 'Saving…' : 'Save As…'}</span>
    </button>
  </>;
}
