import React from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';

export interface RecordPagerProps {
  visible: boolean;
  busy: boolean;
  invalidated: boolean;
  hasBefore: boolean;
  canAdvance: boolean;
  pageInput: string;
  pageRange: string;
  onPrevious: () => void;
  onNext: () => void;
  onJump: () => void;
  onInputFocus: () => void;
  onInputChange: (value: string) => void;
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onInputBlur: () => void;
}

export function RecordPager({
  visible,
  busy,
  invalidated,
  hasBefore,
  canAdvance,
  pageInput,
  pageRange,
  onPrevious,
  onNext,
  onJump,
  onInputFocus,
  onInputChange,
  onInputKeyDown,
  onInputBlur,
}: RecordPagerProps): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <footer className="page-controls" aria-busy={busy}>
      <button
        type="button"
        title="Previous page"
        disabled={invalidated || !hasBefore || busy}
        onClick={onPrevious}
      >
        <ArrowLeft size={14} aria-hidden />Previous
      </button>
      <label className="page-jump" title="Jump to a physical record page; active filters may scan additional rows.">
        <span>Page</span>
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          aria-label="Page number"
          value={pageInput}
          disabled={invalidated}
          onFocus={onInputFocus}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={onInputBlur}
        />
      </label>
      <span className="page-cursor" aria-live="polite">
        {busy ? 'Loading page...' : pageRange}
      </span>
      <button
        type="button"
        title="Next page"
        disabled={invalidated || !canAdvance || busy}
        onClick={onNext}
      >
        Next<ArrowRight size={14} aria-hidden />
      </button>
    </footer>
  );
}
