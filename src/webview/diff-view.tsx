import React from 'react';

export type DiffLineKind = 'header' | 'hunk' | 'add' | 'remove' | 'context' | 'meta' | 'empty';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  marker: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffParseResult {
  lines: DiffLine[];
  truncated: boolean;
  displayedLines: number;
}

export interface DiffParseOptions {
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 2_000;

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function appendLine(lines: DiffLine[], line: DiffLine, maxLines: number): boolean {
  if (lines.length >= maxLines) return false;
  lines.push(line);
  return true;
}

/**
 * Parse only the presentation structure of a unified diff. It deliberately
 * keeps unknown lines as metadata instead of attempting to interpret patch
 * syntax or executing any content.
 */
export function parseUnifiedDiff(source: string, options: DiffParseOptions = {}): DiffParseResult {
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES));
  const lines: DiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  let truncated = false;
  let offset = 0;

  while (offset < source.length || (source.length === 0 && lines.length === 0)) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    const newline = source.indexOf('\n', offset);
    const end = newline === -1 ? source.length : newline;
    const rawLine = source.slice(offset, end);
    offset = newline === -1 ? source.length : newline + 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = numberOrUndefined(hunk[1]);
      newLine = numberOrUndefined(hunk[3]);
      oldRemaining = numberOrUndefined(hunk[2]) ?? 1;
      newRemaining = numberOrUndefined(hunk[4]) ?? 1;
      inHunk = oldRemaining > 0 || newRemaining > 0;
      appendLine(lines, { kind: 'hunk', text: line, marker: '@@' }, maxLines);
      continue;
    }

    if (!inHunk && (
      line.startsWith('diff ')
      || line.startsWith('index ')
      || line.startsWith('file: ')
      || line.startsWith('--- ')
      || line === '---'
      || line.startsWith('+++ ')
      || line === '+++'
      || line.startsWith('new file mode ')
      || line.startsWith('deleted file mode ')
      || line.startsWith('similarity index ')
      || line.startsWith('rename from ')
      || line.startsWith('rename to ')
      || line.startsWith('Binary files ')
    )) {
      appendLine(lines, { kind: 'header', text: line, marker: '' }, maxLines);
      continue;
    }

    if (line.startsWith('+') && (newRemaining > 0 || !line.startsWith('+++'))) {
      const current = newLine;
      if (newLine !== undefined) newLine += 1;
      if (newRemaining > 0) newRemaining -= 1;
      appendLine(lines, {
        kind: 'add',
        text: line.slice(1),
        marker: '+',
        ...(current === undefined ? {} : { newLine: current }),
      }, maxLines);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      continue;
    }

    if (line.startsWith('-') && (oldRemaining > 0 || !line.startsWith('---'))) {
      const current = oldLine;
      if (oldLine !== undefined) oldLine += 1;
      if (oldRemaining > 0) oldRemaining -= 1;
      appendLine(lines, {
        kind: 'remove',
        text: line.slice(1),
        marker: '-',
        ...(current === undefined ? {} : { oldLine: current }),
      }, maxLines);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      continue;
    }

    if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      const currentOld = oldLine;
      const currentNew = newLine;
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
      appendLine(lines, {
        kind: 'context',
        text: line.slice(1),
        marker: ' ',
        ...(currentOld === undefined ? {} : { oldLine: currentOld }),
        ...(currentNew === undefined ? {} : { newLine: currentNew }),
      }, maxLines);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      continue;
    }

    if (line.startsWith('\\ No newline at end of file')) {
      appendLine(lines, { kind: 'meta', text: line, marker: '' }, maxLines);
      continue;
    }

    if (line.length === 0) {
      appendLine(lines, { kind: 'empty', text: '', marker: '' }, maxLines);
      if (newline === -1) break;
      continue;
    }

    appendLine(lines, { kind: 'meta', text: line, marker: '' }, maxLines);
    if (newline === -1) break;
  }

  return { lines, truncated, displayedLines: lines.length };
}

interface DiffViewProps {
  source: string;
  ariaLabel: string;
}

export function DiffView({ source, ariaLabel }: DiffViewProps): React.JSX.Element {
  const [wrap, setWrap] = React.useState(false);
  const parsed = React.useMemo(() => parseUnifiedDiff(source), [source]);
  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="diff-toolbar-label">Unified diff</span>
        <button
          type="button"
          className={wrap ? 'is-active' : ''}
          aria-pressed={wrap}
          title="Wrap diff lines"
          onClick={() => setWrap((current) => !current)}
        >
          Wrap
        </button>
      </div>
      {parsed.truncated ? (
        <div className="content-budget-notice" role="status">
          Diff preview is limited to the first {parsed.displayedLines.toLocaleString()} lines; Raw remains authoritative and Copy uses the available diff source.
        </div>
      ) : null}
      <div className={`diff-lines${wrap ? ' is-wrapped' : ''}`} role="list" aria-label={ariaLabel}>
        {parsed.lines.map((line, index) => (
          <div
            className={`diff-line diff-line-${line.kind}`}
            role="listitem"
            aria-label={`${line.marker}${line.text}`.trimEnd()}
            key={`${index}:${line.kind}`}
          >
            <span className="diff-line-number" aria-hidden>{line.oldLine ?? ''}</span>
            <span className="diff-line-number" aria-hidden>{line.newLine ?? ''}</span>
            <span className="diff-line-marker" aria-hidden>{line.marker}</span>
            <span className="diff-line-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
