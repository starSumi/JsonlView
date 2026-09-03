import React, { useMemo, useState } from 'react';
import type { ParseState } from '../shared/types';
import { CopyButton } from './copy-button';
import { JsonCode, stringifyJsonBounded, type BoundedJsonText } from './json-syntax';

export type RawDisplayMode = 'pretty' | 'source';

const MIN_PRETTY_CHARS = 128 * 1024;
const MAX_PRETTY_CHARS = 4 * 1024 * 1024;
const MIN_PRETTY_STRING_CHARS = 16 * 1024;
const MAX_PRETTY_STRING_CHARS = 512 * 1024;

export function prettyPrintRawJson(
  source: string,
  rawComplete: boolean,
  parseState: ParseState,
): BoundedJsonText | undefined {
  if (!rawComplete || parseState !== 'valid') return undefined;
  try {
    const sourceLength = source.length;
    const maxChars = Math.min(
      MAX_PRETTY_CHARS,
      Math.max(MIN_PRETTY_CHARS, sourceLength * 2),
    );
    const maxStringChars = Math.min(
      MAX_PRETTY_STRING_CHARS,
      Math.max(MIN_PRETTY_STRING_CHARS, sourceLength),
    );
    return stringifyJsonBounded(JSON.parse(source), {
      maxChars,
      maxStringChars,
      maxNodes: 10_000,
      maxDepth: 32,
      maxChildren: 1_000,
    });
  } catch {
    return undefined;
  }
}

interface RawJsonViewProps {
  source: string;
  rawComplete: boolean;
  parseState: ParseState;
}

export function RawJsonView({ source, rawComplete, parseState }: RawJsonViewProps): React.JSX.Element {
  const pretty = useMemo(
    () => prettyPrintRawJson(source, rawComplete, parseState),
    [parseState, rawComplete, source],
  );
  const [mode, setMode] = useState<RawDisplayMode>(() => pretty ? 'pretty' : 'source');
  const [wrapLines, setWrapLines] = useState(true);
  const activeMode: RawDisplayMode = mode === 'pretty' && !pretty ? 'source' : mode;
  const displayed = activeMode === 'pretty' && pretty ? pretty.text : source;

  return (
    <div className={`raw-view${wrapLines ? ' is-wrapped' : ''}`}>
      <div className="raw-mode-switch" role="group" aria-label="Raw JSON display">
        <button
          type="button"
          className={activeMode === 'pretty' ? 'is-active' : ''}
          aria-pressed={activeMode === 'pretty'}
          disabled={!pretty}
          title={pretty ? 'Formatted JSON' : 'Pretty view requires a complete valid JSON record'}
          onClick={() => setMode('pretty')}
        >
          Pretty
        </button>
        <button
          type="button"
          className={activeMode === 'source' ? 'is-active' : ''}
          aria-pressed={activeMode === 'source'}
          title="Exact source preview"
          onClick={() => setMode('source')}
        >
          Source
        </button>
        <button
          type="button"
          className={wrapLines ? 'is-active' : ''}
          aria-pressed={wrapLines}
          title={wrapLines ? 'Keep long JSON lines readable' : 'Preserve one physical line'}
          onClick={() => setWrapLines((current) => !current)}
        >
          Wrap
        </button>
        <CopyButton text={displayed} label="Copy JSON" />
      </div>
      {!rawComplete ? (
        <div className="bounded-notice" role="status">
          Source preview is limited by the hydration budget; bytes beyond this boundary were not delivered to the Webview.
        </div>
      ) : null}
      {activeMode === 'pretty' && pretty?.truncated ? (
        <div className="bounded-notice" role="status">
          Pretty JSON reached its display budget; switch to Source to inspect the exact bounded record preview.
        </div>
      ) : null}
      <JsonCode
        source={displayed}
        ariaLabel={activeMode === 'pretty' ? 'Pretty JSON syntax preview' : 'Exact JSON source preview'}
        className={`${activeMode === 'source' ? 'json-source' : 'json-pretty'}${wrapLines ? ' json-wrap' : ''}`}
        preserveFullSource={activeMode === 'source'}
        collapsible={activeMode === 'pretty'}
      />
    </div>
  );
}
