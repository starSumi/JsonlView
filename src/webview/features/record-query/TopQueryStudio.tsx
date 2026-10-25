import { useEffect, useRef } from 'react';
import type React from 'react';
import { History, Play, SlidersHorizontal, Square, X } from 'lucide-react';
import type { RecordQueryControlsProps } from './RecordQueryControls';
import { RecordQueryControls } from './RecordQueryControls';
import type { QueryHistoryEntry } from './query-history';
import { queryStudioShortcut } from './query-studio-keyboard';

export interface QueryStudioPreset {
  readonly id: string;
  readonly label: string;
  readonly query: string;
}

/** Small, provider-neutral query starters. Selecting one edits the input only. */
export const QUERY_STUDIO_PRESETS: readonly QueryStudioPreset[] = [
  { id: 'errors', label: 'Errors', query: 'error' },
  { id: 'tool-calls', label: 'Tool calls', query: 'tool' },
  { id: 'assistant', label: 'Assistant', query: 'assistant' },
];

export function applyQueryStudioPreset(
  queryControls: Pick<RecordQueryControlsProps, 'onSearchChange'>,
  preset: QueryStudioPreset,
): void {
  queryControls.onSearchChange(preset.query);
}

export interface TopQueryStudioProps {
  readonly open: boolean;
  readonly queryControls: RecordQueryControlsProps;
  readonly history: readonly QueryHistoryEntry[];
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly onHistorySelect: (entry: QueryHistoryEntry) => void;
}

export function TopQueryStudio({
  open,
  queryControls,
  history,
  pending,
  disabled,
  onToggle,
  onClose,
  onRun,
  onCancel,
  onHistorySelect,
}: TopQueryStudioProps): React.JSX.Element {
  const studioRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    studioRef.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled])')
      ?.focus({ preventScroll: true });
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const action = queryStudioShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      insideStudio: event.currentTarget instanceof HTMLElement && event.currentTarget.contains(event.target as Node),
    });
    if (action === 'close') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (action === 'run') {
      event.preventDefault();
      event.stopPropagation();
      onRun();
    }
  };

  return (
    <div className="query-studio-shell">
      <button
        type="button"
        className="query-studio-toggle"
        data-query-studio-toggle
        aria-expanded={open}
        aria-controls="query-studio"
        onClick={onToggle}
      >
        <SlidersHorizontal size={14} aria-hidden />
        <span>Query Studio</span>
      </button>
      {open ? (
        <section
          id="query-studio"
          className="query-studio"
          data-query-studio
          aria-label="Expanded query studio"
          ref={studioRef}
          onKeyDown={handleKeyDown}
        >
          <div className="query-studio-heading">
            <div>
              <strong>Query Studio</strong>
              <small>Build a bounded query with the current table projection.</small>
            </div>
            <button type="button" className="icon-button" aria-label="Close Query Studio" title="Close Query Studio" onClick={onClose}>
              <X size={14} aria-hidden />
            </button>
          </div>
          <div className="query-studio-controls">
            <fieldset className="table-query-toolbar" aria-label="Studio query controls">
              <RecordQueryControls {...queryControls} controlNamePrefix="studio" />
            </fieldset>
          </div>
          <div className="query-studio-actions">
            <button type="button" onClick={onRun} disabled={disabled}>
              <Play size={14} aria-hidden />
              <span>Run query</span>
            </button>
            <button type="button" onClick={onCancel} disabled={!pending}>
              <Square size={13} aria-hidden />
              <span>Cancel</span>
            </button>
          </div>
          <fieldset className="query-studio-presets">
            <legend className="query-studio-history-title">Templates</legend>
            {QUERY_STUDIO_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                data-query-studio-preset={preset.id}
                title={`Use query template: ${preset.query}`}
                onClick={() => applyQueryStudioPreset(queryControls, preset)}
              >
                {preset.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="query-studio-history">
            <legend className="query-studio-history-title"><History size={13} aria-hidden /> History</legend>
            {history.length === 0 ? <small>No queries this session</small> : history.map((entry) => (
              <button type="button" key={entry.id} title={entry.label} onClick={() => onHistorySelect(entry)}>
                {entry.label}
              </button>
            ))}
          </fieldset>
        </section>
      ) : null}
    </div>
  );
}
