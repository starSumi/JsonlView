import type React from 'react';
import { LoaderCircle, Play, Square } from 'lucide-react';

export interface RunQueryActionProps {
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly size?: 'normal' | 'compact';
}

export function RunQueryAction({
  pending,
  disabled,
  onRun,
  onCancel,
  size = 'normal',
}: RunQueryActionProps): React.JSX.Element {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/u.test(navigator.platform);
  const shortcut = isMac ? '⌘↵' : 'Ctrl+Enter';

  return (
    <div className={`run-query-capsule size-${size} ${pending ? 'is-pending' : 'is-idle'}`}>
      <span className="run-query-status" role="status" aria-live="polite" aria-atomic="true">
        {pending ? <><LoaderCircle size={13} className="run-query-spinner" aria-hidden /><span>Scanning…</span></> : null}
      </span>
      {/* Keep this native button mounted so a pinned Studio retains focus across Run/Cancel transitions. */}
      <button
        type="button"
        className={`run-query-button ${pending ? 'run-query-cancel' : 'run-query-run'}`}
        disabled={!pending && disabled}
        aria-disabled={!pending && disabled}
        aria-label={pending ? 'Cancel running query' : 'Run query'}
        aria-keyshortcuts={pending ? 'Escape' : 'Control+Enter Meta+Enter'}
        title={pending ? 'Cancel running query (Esc)' : disabled ? 'Query unavailable while the source is not readable' : `Run query (${isMac ? '⌘+Enter' : 'Ctrl+Enter'})`}
        onClick={() => {
          if (pending) onCancel();
          else if (!disabled) onRun();
        }}
      >
        <span className="run-query-main">
          {pending ? <Square size={11} fill="currentColor" aria-hidden /> : <Play size={12} fill="currentColor" strokeWidth={0} aria-hidden />}
          <span>{pending ? 'Cancel' : 'Run query'}</span>
        </span>
        {!pending ? <kbd className="run-query-kbd">{shortcut}</kbd> : null}
      </button>
    </div>
  );
}
