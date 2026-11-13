import { useRef } from 'react';
import type React from 'react';
import { History, Maximize2, Minimize2, Pin, Play, X } from 'lucide-react';
import type { RecordQueryControlsProps } from './RecordQueryControls';
import { RecordQueryControls } from './RecordQueryControls';
import { RunQueryAction } from './RunQueryAction';
import type { QueryHistoryEntry } from './query-history';
import { queryStudioShortcut } from './query-studio-keyboard';
import { useQueryStudioLightDismiss } from './use-query-studio-light-dismiss';
import { useNativePopoverAnchor } from './use-native-popover-anchor';

export interface QueryStudioPreset {
  readonly id: string;
  readonly label: string;
  readonly query: string;
}

export interface QueryStudioSize {
  readonly width: number;
  readonly height: number;
}

// These values are the selected prototype baseline; S0 has not frozen settings.
export const QUERY_STUDIO_DEFAULT_SIZE: QueryStudioSize = { width: 640, height: 430 };
export const QUERY_STUDIO_SIZE_LIMITS = {
  minWidth: 480,
  maxWidth: 1100,
  minHeight: 320,
  maxHeight: 800,
  step: 20,
} as const;

export function clampQueryStudioSize(size: QueryStudioSize): QueryStudioSize {
  const width = Number.isFinite(size.width) ? Math.round(size.width) : QUERY_STUDIO_DEFAULT_SIZE.width;
  const height = Number.isFinite(size.height) ? Math.round(size.height) : QUERY_STUDIO_DEFAULT_SIZE.height;
  return {
    width: Math.max(QUERY_STUDIO_SIZE_LIMITS.minWidth, Math.min(QUERY_STUDIO_SIZE_LIMITS.maxWidth, width)),
    height: Math.max(QUERY_STUDIO_SIZE_LIMITS.minHeight, Math.min(QUERY_STUDIO_SIZE_LIMITS.maxHeight, height)),
  };
}

export function stepQueryStudioSize(
  size: QueryStudioSize,
  dimension: 'width' | 'height',
  direction: -1 | 1,
): QueryStudioSize {
  const delta = direction * QUERY_STUDIO_SIZE_LIMITS.step;
  return clampQueryStudioSize({
    ...size,
    [dimension]: size[dimension] + delta,
  });
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
  readonly pinned: boolean;
  readonly size: QueryStudioSize;
  readonly maximized: boolean;
  readonly queryControls: RecordQueryControlsProps;
  readonly history: readonly QueryHistoryEntry[];
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onTogglePin: () => void;
  readonly onSizeChange: (size: QueryStudioSize) => void;
  readonly onToggleMaximize: () => void;
  readonly onClose: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly onHistorySelect: (entry: QueryHistoryEntry) => void;
}

export function TopQueryStudio({
  open,
  pinned,
  size,
  maximized,
  queryControls,
  history,
  pending,
  disabled,
  onToggle,
  onTogglePin,
  onSizeChange,
  onToggleMaximize,
  onClose,
  onRun,
  onCancel,
  onHistorySelect,
}: TopQueryStudioProps): React.JSX.Element {
  const studioRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const runDisabled = disabled || queryControls.searchDisabled;
  const runQuery = (): void => {
    if (!pending && !runDisabled) onRun();
  };
  useQueryStudioLightDismiss(studioRef, toggleRef, open && !pinned, onClose);
  const { style: anchorStyle } = useNativePopoverAnchor({
    open,
    maximized,
    size,
    studioRef,
    toggleRef,
    onSizeChange,
    clampSize: clampQueryStudioSize,
  });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (maximized && event.key === 'Tab') {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
      } else {
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        const active = document.activeElement;
        if ((event.shiftKey && (active === first || active === event.currentTarget)) || (!event.shiftKey && active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
      }
      return;
    }
    const insideStudio = event.currentTarget instanceof HTMLElement && event.currentTarget.contains(event.target as Node);
    const action = queryStudioShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      insideStudio,
      pending,
      disabled: runDisabled,
    });
    // Consume modified Enter even when unavailable, so its native form submit cannot bypass the guard.
    const modifiedEnter = insideStudio && !event.nativeEvent.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey);
    if (action === undefined && !modifiedEnter) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'close') {
      onClose();
    } else if (action === 'cancel') {
      onCancel();
    } else if (action === 'run') {
      runQuery();
    }
  };

  const resizeControl = (dimension: 'width' | 'height', direction: -1 | 1): void => {
    onSizeChange(stepQueryStudioSize(size, dimension, direction));
  };

  const sizeOutput = `${size.width} by ${size.height} pixels`;

  return (
    <div className="query-studio-shell">
      <button
        type="button"
        className="query-studio-toggle"
        data-query-studio-toggle
        ref={toggleRef}
        aria-label={open ? 'Close Query Studio' : 'Open Query Studio'}
        title={open ? 'Close Query Studio' : 'Open Query Studio'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="query-studio"
        onClick={onToggle}
      >
        <Play size={14} aria-hidden fill="currentColor" strokeWidth={0} />
      </button>
      {open ? (
        <section
          id="query-studio"
          className="query-studio"
          data-query-studio
          popover="manual"
          data-query-studio-maximized={maximized}
          role="dialog"
          aria-modal={maximized ? true : undefined}
          aria-label="Expanded query studio"
          ref={studioRef}
          tabIndex={-1}
          style={anchorStyle as React.CSSProperties}
          onKeyDown={handleKeyDown}
        >
          <div className="query-studio-heading">
            <div>
              <strong>Query Studio</strong>
              <small>Build a bounded query with the current table projection.</small>
            </div>
            <div className="query-studio-heading-actions">
              <button
                type="button"
                className="icon-button query-studio-pin"
                aria-label="Keep open"
                aria-pressed={pinned}
                title="Keep open; position is not locked"
                onClick={onTogglePin}
              >
                <Pin size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={maximized ? 'Restore Query Studio' : 'Maximize Query Studio'}
                title={maximized ? 'Restore Query Studio' : 'Maximize Query Studio'}
                aria-pressed={maximized}
                onClick={onToggleMaximize}
              >
                {maximized ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
              </button>
              <button type="button" className="icon-button" aria-label="Close Query Studio" title="Close Query Studio" onClick={onClose}>
                <X size={14} aria-hidden />
              </button>
            </div>
          </div>
          <div className="query-studio-controls">
            <fieldset className="table-query-toolbar" aria-label="Studio query controls">
              <RecordQueryControls {...queryControls} controlNamePrefix="studio" onSearchSubmit={runQuery} />
            </fieldset>
          </div>
          <div className="query-studio-actions">
            <RunQueryAction pending={pending} disabled={runDisabled} onRun={runQuery} onCancel={onCancel} />
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
          <fieldset className="query-studio-size-controls" aria-label="Query Studio size controls">
            <span>Size</span>
            <button type="button" aria-label="Make Query Studio narrower" title="Make Query Studio narrower"
              disabled={maximized || size.width <= QUERY_STUDIO_SIZE_LIMITS.minWidth} onClick={() => resizeControl('width', -1)}>
              −
            </button>
            <button type="button" aria-label="Make Query Studio wider" title="Make Query Studio wider"
              disabled={maximized || size.width >= QUERY_STUDIO_SIZE_LIMITS.maxWidth} onClick={() => resizeControl('width', 1)}>
              +
            </button>
            <span className="query-studio-size-divider" aria-hidden="true" />
            <button type="button" aria-label="Make Query Studio shorter" title="Make Query Studio shorter"
              disabled={maximized || size.height <= QUERY_STUDIO_SIZE_LIMITS.minHeight} onClick={() => resizeControl('height', -1)}>
              −
            </button>
            <button type="button" aria-label="Make Query Studio taller" title="Make Query Studio taller"
              disabled={maximized || size.height >= QUERY_STUDIO_SIZE_LIMITS.maxHeight} onClick={() => resizeControl('height', 1)}>
              +
            </button>
            <output aria-label={`Query Studio size ${sizeOutput}`}>{size.width} × {size.height}</output>
          </fieldset>
        </section>
      ) : null}
    </div>
  );
}
