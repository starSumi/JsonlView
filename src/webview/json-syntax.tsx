import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export type JsonSyntaxKind =
  | 'plain'
  | 'punctuation'
  | 'key'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null';

export interface JsonSyntaxToken {
  kind: JsonSyntaxKind;
  text: string;
}

export interface JsonSyntaxResult {
  tokens: JsonSyntaxToken[];
  truncated: boolean;
  displayedChars: number;
}

export interface JsonSyntaxOptions {
  maxChars?: number;
  maxTokens?: number;
}

export interface BoundedJsonOptions {
  maxChars?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxChildren?: number;
  maxStringChars?: number;
}

export interface BoundedJsonText {
  text: string;
  truncated: boolean;
}

export interface JsonFoldLine {
  lineNumber: number;
  text: string;
  foldEndLine?: number;
}

const DEFAULT_MAX_CHARS = 128 * 1024;
const DEFAULT_MAX_TOKENS = 8_000;

/**
 * Build a line model from pretty JSON without parsing values again. Bracket
 * matching is string-aware, so braces inside log messages do not create false
 * fold ranges.
 */
export function buildJsonFoldLines(source: string): JsonFoldLine[] {
  const texts = source.split(/\r?\n/);
  const closeByOpen = new Map<number, number>();
  const stack: Array<{ bracket: '{' | '['; line: number }> = [];
  let line = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character === '\n') {
      line += 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push({ bracket: character, line });
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    const opening = stack.at(-1);
    if (opening?.bracket !== expected) continue;
    stack.pop();
    if (opening.line < line - 1) closeByOpen.set(opening.line, line);
  }

  return texts.map((text, lineNumber) => {
    const foldEndLine = closeByOpen.get(lineNumber);
    return {
      lineNumber,
      text,
      ...(foldEndLine === undefined ? {} : { foldEndLine }),
    };
  });
}

export function visibleJsonFoldLines(
  lines: readonly JsonFoldLine[],
  collapsedLines: ReadonlySet<number>,
): JsonFoldLine[] {
  const hidden = new Set<number>();
  for (const line of lines) {
    const end = line.foldEndLine;
    if (end === undefined || !collapsedLines.has(line.lineNumber)) continue;
    for (let index = line.lineNumber + 1; index < end; index += 1) hidden.add(index);
  }
  return lines.filter((line) => !hidden.has(line.lineNumber));
}

function appendToken(tokens: JsonSyntaxToken[], kind: JsonSyntaxKind, text: string): void {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.kind === kind) {
    previous.text += text;
    return;
  }
  tokens.push({ kind, text });
}

function isWordBoundary(character: string | undefined): boolean {
  return character === undefined || !/[A-Za-z0-9_$]/.test(character);
}

function scanString(source: string, start: number): number {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor = Math.min(source.length, cursor + 2);
      continue;
    }
    cursor += 1;
    if (source[cursor - 1] === '"') break;
  }
  return cursor;
}

function isObjectKey(source: string, stringEnd: number): boolean {
  let cursor = stringEnd;
  while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1;
  return source[cursor] === ':';
}

function scanNumber(source: string, start: number): number {
  let cursor = start;
  if (source[cursor] === '-') cursor += 1;
  if (source[cursor] === '0') {
    cursor += 1;
  } else {
    while (/\d/.test(source[cursor] ?? '')) cursor += 1;
  }
  if (source[cursor] === '.') {
    cursor += 1;
    while (/\d/.test(source[cursor] ?? '')) cursor += 1;
  }
  if (source[cursor] === 'e' || source[cursor] === 'E') {
    cursor += 1;
    if (source[cursor] === '+' || source[cursor] === '-') cursor += 1;
    while (/\d/.test(source[cursor] ?? '')) cursor += 1;
  }
  return cursor;
}

export function tokenizeJson(
  source: string,
  options: JsonSyntaxOptions = {},
): JsonSyntaxResult {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxTokens = Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const visible = source.slice(0, maxChars);
  const tokens: JsonSyntaxToken[] = [];
  let cursor = 0;

  while (cursor < visible.length && tokens.length < maxTokens) {
    const character = visible[cursor] ?? '';
    if (character === '"') {
      const end = scanString(visible, cursor);
      appendToken(tokens, isObjectKey(visible, end) ? 'key' : 'string', visible.slice(cursor, end));
      cursor = end;
      continue;
    }
    if ('{}[],:'.includes(character)) {
      appendToken(tokens, 'punctuation', character);
      cursor += 1;
      continue;
    }
    if (character === '-' || /\d/.test(character)) {
      const end = scanNumber(visible, cursor);
      appendToken(tokens, 'number', visible.slice(cursor, Math.max(cursor + 1, end)));
      cursor = Math.max(cursor + 1, end);
      continue;
    }

    let matched = false;
    for (const [word, kind] of [
      ['true', 'boolean'],
      ['false', 'boolean'],
      ['null', 'null'],
    ] as const) {
      if (
        visible.startsWith(word, cursor)
        && isWordBoundary(visible[cursor - 1])
        && isWordBoundary(visible[cursor + word.length])
      ) {
        appendToken(tokens, kind, word);
        cursor += word.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    let end = cursor + 1;
    while (end < visible.length) {
      const next = visible[end] ?? '';
      if (next === '"' || '{}[],:-'.includes(next) || /\d/.test(next)) break;
      if (visible.startsWith('true', end) || visible.startsWith('false', end) || visible.startsWith('null', end)) break;
      end += 1;
    }
    appendToken(tokens, 'plain', visible.slice(cursor, end));
    cursor = end;
  }

  if (cursor < visible.length) {
    appendToken(tokens, 'plain', visible.slice(cursor));
  }

  return {
    tokens,
    truncated: source.length > visible.length || cursor < visible.length,
    displayedChars: visible.length,
  };
}

function safeProperty(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return '[Unreadable property]';
  }
}

export function stringifyJsonBounded(
  value: unknown,
  options: BoundedJsonOptions = {},
): BoundedJsonText {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxNodes = Math.max(1, options.maxNodes ?? 1_000);
  const maxDepth = Math.max(0, options.maxDepth ?? 12);
  const maxChildren = Math.max(1, options.maxChildren ?? 100);
  const maxStringChars = Math.max(1, options.maxStringChars ?? 2_048);
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bounded = false;

  const project = (node: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > maxNodes) {
      bounded = true;
      return '[Truncated: node budget]';
    }
    if (typeof node === 'string') {
      if (node.length <= maxStringChars) return node;
      bounded = true;
      return `${node.slice(0, maxStringChars)}... [truncated]`;
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'number') return node;
    if (typeof node === 'bigint') return `${String(node)}n`;
    if (typeof node !== 'object') return String(node);
    if (seen.has(node)) {
      bounded = true;
      return '[Circular]';
    }
    if (depth >= maxDepth) {
      bounded = true;
      return '[Truncated: depth limit]';
    }
    seen.add(node);

    if (Array.isArray(node)) {
      const projected: unknown[] = [];
      const count = Math.min(node.length, maxChildren);
      for (let index = 0; index < count && nodes <= maxNodes; index += 1) {
        projected.push(project(node[index], depth + 1));
      }
      if (node.length > count) {
        bounded = true;
        projected.push(`[Truncated: ${String(node.length - count)} more items]`);
      }
      return projected;
    }

    const projected: Record<string, unknown> = {};
    let count = 0;
    let hasMore = false;
    for (const key in node as Record<string, unknown>) {
      if (!Object.hasOwn(node, key)) continue;
      if (count >= maxChildren || nodes > maxNodes) {
        hasMore = true;
        break;
      }
      projected[key] = project(safeProperty(node as Record<string, unknown>, key), depth + 1);
      count += 1;
    }
    if (hasMore) {
      bounded = true;
      projected['...'] = '[Truncated: more fields]';
    }
    return projected;
  };

  let text: string;
  try {
    text = JSON.stringify(project(value, 0), null, 2) ?? String(value);
  } catch {
    return { text: 'Value cannot be serialized.', truncated: true };
  }
  if (text.length > maxChars) {
    return { text: text.slice(0, maxChars), truncated: true };
  }
  return { text, truncated: bounded };
}

interface JsonCodeProps {
  source: string;
  ariaLabel: string;
  className?: string;
  preserveFullSource?: boolean;
  collapsible?: boolean;
}

interface JsonFoldCodeProps extends JsonCodeProps {
  collapsible: true;
}

function TokenSpans({ source, lineKey }: { source: string; lineKey: string }): React.JSX.Element {
  const result = tokenizeJson(source, { maxChars: Math.max(1, source.length) });
  return (
    <>
      {result.tokens.map((token, index) => (
        token.kind === 'plain'
          ? <React.Fragment key={`${lineKey}:plain:${index}`}>{token.text}</React.Fragment>
          : <span className={`json-token json-token-${token.kind}`} key={`${lineKey}:${token.kind}:${index}`}>{token.text}</span>
      ))}
      {source.slice(result.displayedChars)}
    </>
  );
}

function JsonFoldCode({ source, ariaLabel, className }: JsonFoldCodeProps): React.JSX.Element {
  const lines = React.useMemo(() => buildJsonFoldLines(source), [source]);
  const [collapsedLines, setCollapsedLines] = React.useState<ReadonlySet<number>>(() => new Set());
  const visibleLines = React.useMemo(
    () => visibleJsonFoldLines(lines, collapsedLines),
    [collapsedLines, lines],
  );
  const viewId = React.useId().replaceAll(':', '');

  const toggle = (lineNumber: number): void => {
    setCollapsedLines((current) => {
      const next = new Set(current);
      if (next.has(lineNumber)) next.delete(lineNumber);
      else next.add(lineNumber);
      return next;
    });
  };

  return (
    <div className={`json-code json-fold-view${className ? ` ${className}` : ''}`} role="tree" aria-label={ariaLabel}>
      {visibleLines.map((line) => {
        const foldEndLine = line.foldEndLine;
        const collapsed = collapsedLines.has(line.lineNumber);
        const hiddenCount = foldEndLine === undefined ? 0 : foldEndLine - line.lineNumber - 1;
        const foldId = `${viewId}-fold-${String(line.lineNumber)}`;
        return (
          <React.Fragment key={line.lineNumber}>
            <div className="json-line" role="treeitem" aria-level={1} aria-expanded={foldEndLine === undefined ? undefined : !collapsed}>
              <span className="json-line-gutter">
                {foldEndLine !== undefined ? (
                  <button
                    type="button"
                    className="json-fold-toggle"
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} JSON block at line ${String(line.lineNumber + 1)}`}
                    aria-controls={foldId}
                    aria-expanded={!collapsed}
                    onClick={() => toggle(line.lineNumber)}
                  >
                    {collapsed ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
                  </button>
                ) : <span className="json-fold-spacer" aria-hidden />}
                <span className="json-line-number">{line.lineNumber + 1}</span>
              </span>
              <span className="json-line-code" id={foldEndLine !== undefined ? foldId : undefined}>
                <TokenSpans source={line.text} lineKey={`${viewId}:${line.lineNumber}`} />
                {collapsed ? <span className="json-fold-ellipsis" aria-hidden> …</span> : null}
              </span>
            </div>
            {collapsed && hiddenCount > 0 ? (
              <div className="json-fold-summary" role="note">
                <span className="json-line-gutter"><span className="json-fold-spacer" aria-hidden /></span>
                <span>… {String(hiddenCount)} lines hidden</span>
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function JsonCode({
  source,
  ariaLabel,
  className,
  preserveFullSource = false,
  collapsible = false,
}: JsonCodeProps): React.JSX.Element {
  if (collapsible) {
    return (
      <JsonFoldCode
        source={source}
        ariaLabel={ariaLabel}
        {...(className === undefined ? {} : { className })}
        collapsible
      />
    );
  }
  const result = React.useMemo(() => tokenizeJson(source), [source]);
  const unhighlightedRemainder = preserveFullSource ? source.slice(result.displayedChars) : '';
  return (
    <>
      {result.truncated ? (
        <div className="bounded-notice" role="status">
          {preserveFullSource
            ? `Syntax highlighting is limited to the first ${result.displayedChars.toLocaleString()} characters; the remaining source stays available below.`
            : `Syntax preview is limited to the first ${result.displayedChars.toLocaleString()} characters.`}
        </div>
      ) : null}
      <pre className={`json-code${className ? ` ${className}` : ''}`} aria-label={ariaLabel}>
        {result.tokens.map((token, index) => (
          token.kind === 'plain'
            ? <React.Fragment key={index}>{token.text}</React.Fragment>
            : <span className={`json-token json-token-${token.kind}`} key={index}>{token.text}</span>
        ))}
        {unhighlightedRemainder}
      </pre>
    </>
  );
}
