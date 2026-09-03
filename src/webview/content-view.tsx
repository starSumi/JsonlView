import React from 'react';
import { AlignLeft, Braces, FileText, Sparkles } from 'lucide-react';
import { HighlightedCode } from './code-syntax';
import { CopyButton } from './copy-button';
import { JsonCode, stringifyJsonBounded } from './json-syntax';

export type ContentMode = 'auto' | 'text' | 'markdown' | 'json';
export type DetectedContentKind = 'text' | 'markdown' | 'json';

export interface EmbeddedJsonCandidate {
  start: number;
  end: number;
  source: string;
  value: object | unknown[];
}

interface MarkdownHeading {
  kind: 'heading';
  level: number;
  text: string;
}

interface MarkdownParagraph {
  kind: 'paragraph';
  lines: string[];
}

interface MarkdownQuote {
  kind: 'quote';
  lines: string[];
}

interface MarkdownList {
  kind: 'list';
  ordered: boolean;
  items: string[];
}

interface MarkdownCode {
  kind: 'code';
  language: string;
  source: string;
}

interface MarkdownFence {
  marker: '`' | '~';
  length: number;
  language: string;
}

interface MarkdownTable {
  kind: 'table';
  header: string[];
  rows: string[][];
}

interface MarkdownRule {
  kind: 'rule';
}

type MarkdownBlock =
  | MarkdownHeading
  | MarkdownParagraph
  | MarkdownQuote
  | MarkdownList
  | MarkdownCode
  | MarkdownTable
  | MarkdownRule;

const MAX_RICH_TEXT_CHARS = 64 * 1024;
const MAX_MARKDOWN_BLOCKS = 256;
const MAX_MARKDOWN_ROWS = 128;
const MAX_MARKDOWN_CELLS = 32;
const MAX_INLINE_PARTS = 256;

function objectOrArray(value: unknown): value is object | unknown[] {
  return value !== null && typeof value === 'object';
}

function parseJsonObjectOrArray(source: string): object | unknown[] | undefined {
  const trimmed = source.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return objectOrArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find parseable object/array values embedded in prose. The scanner is
 * string-aware and bounded; braces in quoted strings or escaped JSON do not
 * terminate a candidate.
 */
export function extractEmbeddedJson(source: string): EmbeddedJsonCandidate[] {
  const candidates: EmbeddedJsonCandidate[] = [];
  const maxCandidates = 4;
  for (let start = 0; start < source.length && candidates.length < maxCandidates; start += 1) {
    const opening = source[start];
    if (opening !== '{' && opening !== '[') continue;
    const stack: string[] = [opening];
    let inString = false;
    let escaped = false;
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const character = source[cursor] ?? '';
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
        stack.push(character);
        continue;
      }
      if (character !== '}' && character !== ']') continue;
      const expected = character === '}' ? '{' : '[';
      if (stack.at(-1) !== expected) break;
      stack.pop();
      if (stack.length !== 0) continue;
      const candidateSource = source.slice(start, cursor + 1);
      if (candidateSource.length <= MAX_RICH_TEXT_CHARS) {
        const value = parseJsonObjectOrArray(candidateSource);
        if (value !== undefined) {
          candidates.push({ start, end: cursor + 1, source: candidateSource, value });
          start = cursor;
        }
      }
      break;
    }
  }
  return candidates;
}

function hasMarkdownSignal(source: string): boolean {
  const lines = source.split(/\r?\n/);
  let tableSeparator = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (/^#{1,6}\s+\S/.test(line) || /^(?:`{3,}|~{3,})\s*[A-Za-z0-9_+#.-]*\s*$/.test(line)) return true;
    if (/^(?:[-*+]\s+|\d+[.)]\s+|>\s?)/.test(line)) return true;
    if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(line)) return true;
    if (line.includes('|') && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1]?.trim() ?? '')) {
      tableSeparator = true;
    }
  }
  return tableSeparator || /\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\)/.test(source);
}

export function classifyContent(source: string): DetectedContentKind {
  const bounded = source.slice(0, MAX_RICH_TEXT_CHARS);
  if (parseJsonObjectOrArray(bounded) !== undefined && bounded.trim() === source.trim()) return 'json';
  if (extractEmbeddedJson(bounded).length > 0 && !hasMarkdownSignal(bounded)) return 'json';
  return hasMarkdownSignal(bounded) ? 'markdown' : 'text';
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').slice(0, MAX_MARKDOWN_CELLS).map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function isFenceStart(line: string): MarkdownFence | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/);
  const markerText = match?.[1];
  if (!markerText) return undefined;
  const marker = markerText[0];
  if (marker !== '`' && marker !== '~') return undefined;
  return {
    marker,
    length: markerText.length,
    language: match?.[2]?.toLowerCase() ?? '',
  };
}

function isFenceEnd(line: string, fence: MarkdownFence): boolean {
  const candidate = line.match(/^\s*(`{3,}|~{3,})[ \t]*$/)?.[1];
  return candidate !== undefined && candidate[0] === fence.marker && candidate.length >= fence.length;
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length && blocks.length < MAX_MARKDOWN_BLOCKS) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    const fence = isFenceStart(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !isFenceEnd(lines[index] ?? '', fence)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', language: fence.language, source: body.join('\n') });
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: Math.min(6, heading[1]?.length ?? 1), text: heading[2] ?? '' });
      index += 1;
      continue;
    }
    if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]?.trim() && rows.length < MAX_MARKDOWN_ROWS) {
        rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }
    const listMatch = trimmed.match(/^([-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1] ?? '');
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? '').trim().match(/^([-*+]\s+|\d+[.)]\s+)(.*)$/);
        if (!item || (/^\d/.test(item[1] ?? '') !== ordered)) break;
        items.push(item[2] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (!next.trim() || isFenceStart(next) || /^(?:#{1,6})\s+/.test(next.trim()) || /^>\s?/.test(next.trim()) || /^([-*+]\s+|\d+[.)]\s+)/.test(next.trim())) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

function safeHref(value: string): string | undefined {
  return /^(?:https?:|mailto:)/i.test(value.trim()) ? value.trim() : undefined;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let index = 0;
  while (rest && nodes.length < MAX_INLINE_PARTS) {
    const match = rest.match(/(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!\w)_([^_\n]+)_(?!\w)|\[([^\]\n]+)\]\(([^)\n]+)\))/);
    if (!match || match.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];
    if (token.startsWith('`')) nodes.push(<code key={`${keyPrefix}:${index}`} className="content-inline-code">{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) nodes.push(<strong key={`${keyPrefix}:${index}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*') || token.startsWith('_')) nodes.push(<em key={`${keyPrefix}:${index}`}>{token.slice(1, -1)}</em>);
    else {
      const link = token.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)$/);
      const label = link?.[1] ?? token;
      const href = safeHref(link?.[2] ?? '');
      nodes.push(href
        ? <a key={`${keyPrefix}:${index}`} className="content-link" href={href} rel="noreferrer">{label}</a>
        : <span key={`${keyPrefix}:${index}`} className="content-link">{label}</span>);
    }
    rest = rest.slice(match.index + token.length);
    index += 1;
  }
  return nodes;
}

function MarkdownCodeBlock({ language, source }: MarkdownCode): React.JSX.Element {
  const [wrap, setWrap] = React.useState(false);
  const json = language === 'json' || language === 'jsonc' ? parseJsonObjectOrArray(source) : undefined;
  const label = language || 'Code';
  let body: React.JSX.Element;
  if (json !== undefined) {
    const bounded = stringifyJsonBounded(json, { maxChars: 256 * 1024, maxNodes: 10_000, maxDepth: 32, maxChildren: 1_000 });
    body = (
      <div className="content-json-block">
        {bounded.truncated ? <div className="content-budget-notice" role="status">Embedded JSON is bounded for display.</div> : null}
        <JsonCode source={bounded.text} ariaLabel={`${label} JSON`} {...(wrap ? { className: 'json-wrap' } : {})} collapsible />
      </div>
    );
  } else {
    body = <HighlightedCode source={source} language={language} ariaLabel={`${label} code`} {...(wrap ? { className: 'is-wrapped' } : {})} />;
  }
  return (
    <section className={`content-code-block${wrap ? ' is-wrapped' : ''}`}>
      <header className="content-code-header">
        <span className="content-code-language">{label}</span>
        <div className="content-code-actions">
          <button type="button" className={wrap ? 'is-active' : ''} aria-pressed={wrap} onClick={() => setWrap((current) => !current)}>
            Wrap
          </button>
          <CopyButton text={source} label={`Copy ${label} block`} />
        </div>
      </header>
      {body}
    </section>
  );
}

function MarkdownView({ source }: { source: string }): React.JSX.Element {
  const blocks = React.useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="content-markdown">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          const Heading = `h${String(block.level)}` as keyof React.JSX.IntrinsicElements;
          return <Heading key={index}>{renderInline(block.text, `heading:${index}`)}</Heading>;
        }
        if (block.kind === 'paragraph') return <p key={index}>{block.lines.map((line, lineIndex) => <React.Fragment key={lineIndex}>{lineIndex ? <br /> : null}{renderInline(line, `paragraph:${index}:${lineIndex}`)}</React.Fragment>)}</p>;
        if (block.kind === 'quote') return <blockquote key={index}>{block.lines.map((line, lineIndex) => <React.Fragment key={lineIndex}>{lineIndex ? <br /> : null}{renderInline(line, `quote:${index}:${lineIndex}`)}</React.Fragment>)}</blockquote>;
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `list:${index}:${itemIndex}`)}</li>)}</List>;
        }
        if (block.kind === 'rule') return <hr key={index} />;
        if (block.kind === 'table') return (
          <div className="content-table-wrap" key={index}>
            <table className="content-table"><thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell, `table-head:${index}:${cellIndex}`)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.header.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '', `table:${index}:${rowIndex}:${cellIndex}`)}</td>)}</tr>)}</tbody></table>
          </div>
        );
        return <MarkdownCodeBlock key={index} {...block} />;
      })}
    </div>
  );
}

interface ContentViewProps {
  text: string;
  truncated?: boolean;
  ariaLabel?: string;
  defaultMode?: ContentMode;
}

const modeButtons: Array<{ id: ContentMode; label: string; Icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }> }> = [
  { id: 'auto', label: 'Auto', Icon: Sparkles },
  { id: 'text', label: 'Text', Icon: AlignLeft },
  { id: 'markdown', label: 'Markdown', Icon: FileText },
  { id: 'json', label: 'JSON', Icon: Braces },
];

function jsonPresentation(source: string): React.JSX.Element | undefined {
  const value = parseJsonObjectOrArray(source);
  if (value === undefined) return undefined;
  const bounded = stringifyJsonBounded(value, { maxChars: 256 * 1024, maxNodes: 10_000, maxDepth: 32, maxChildren: 1_000 });
  return <div className="content-json-block">{bounded.truncated ? <div className="content-budget-notice" role="status">Embedded JSON is bounded for display.</div> : null}<JsonCode source={bounded.text} ariaLabel="Embedded JSON" collapsible /></div>;
}

function autoPresentation(source: string): React.JSX.Element {
  const wholeJson = jsonPresentation(source);
  if (wholeJson) return wholeJson;
  // Markdown owns fenced blocks and structural syntax. Only extract inline
  // JSON from prose when the text is otherwise not confidently Markdown.
  if (hasMarkdownSignal(source)) return <MarkdownView source={source} />;
  const candidates = extractEmbeddedJson(source);
  if (candidates.length) {
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    candidates.forEach((candidate, index) => {
      if (candidate.start > cursor) parts.push(<span className="content-text-inline" key={`text:${index}`}>{source.slice(cursor, candidate.start)}</span>);
      const rendered = jsonPresentation(candidate.source);
      if (rendered) parts.push(<React.Fragment key={`json:${index}`}>{rendered}</React.Fragment>);
      cursor = candidate.end;
    });
    if (cursor < source.length) parts.push(<span className="content-text-inline" key="text:tail">{source.slice(cursor)}</span>);
    return <div className="content-mixed">{parts}</div>;
  }
  return <div className="content-text">{source}</div>;
}

export function ContentView({ text, truncated = false, ariaLabel = 'Event content', defaultMode = 'auto' }: ContentViewProps): React.JSX.Element {
  const [mode, setMode] = React.useState<ContentMode>(defaultMode);
  React.useEffect(() => setMode(defaultMode), [defaultMode]);
  const bounded = text.slice(0, MAX_RICH_TEXT_CHARS);
  const analysisTruncated = text.length > bounded.length;
  const detected = React.useMemo(() => classifyContent(bounded), [bounded]);
  let body: React.JSX.Element;
  if (mode === 'text') body = <div className="content-text">{text}</div>;
  else if (mode === 'markdown') body = <MarkdownView source={bounded} />;
  else if (mode === 'json') body = jsonPresentation(bounded) ?? <div className="content-text">{text}</div>;
  else body = autoPresentation(bounded);

  return (
    <div className="content-view" aria-label={ariaLabel}>
      <div className="content-toolbar">
        <div className="content-mode-switch" role="group" aria-label="Content format">
          {modeButtons.map(({ id, label, Icon }) => (
            <button type="button" className={mode === id ? 'is-active' : ''} aria-pressed={mode === id} key={id} onClick={() => setMode(id)}>
              <Icon size={13} aria-hidden />{label}
            </button>
          ))}
        </div>
        <span className="content-detected" title="Detected source format">Detected: {detected}</span>
      </div>
      {truncated ? <div className="content-budget-notice" role="status">Preview limited to 8,000 characters. Choose Show full to inspect the complete field.</div> : null}
      {analysisTruncated ? <div className="content-budget-notice" role="status">Rich parsing is limited to the first {MAX_RICH_TEXT_CHARS.toLocaleString()} characters; Text keeps the complete value.</div> : null}
      <div className="content-body">{body}</div>
    </div>
  );
}
