import React from 'react';

export type CodeSyntaxKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword';

export interface CodeSyntaxToken {
  kind: CodeSyntaxKind;
  text: string;
}

export interface CodeSyntaxResult {
  tokens: CodeSyntaxToken[];
  truncated: boolean;
  displayedChars: number;
}

export interface CodeSyntaxOptions {
  maxChars?: number;
  maxTokens?: number;
}

const DEFAULT_MAX_CHARS = 128 * 1024;
const DEFAULT_MAX_TOKENS = 12_000;

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  python: new Set('and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield'.split(' ')),
  shell: new Set('case do done elif else esac fi for function if in select then until while export local readonly declare'.split(' ')),
  javascript: new Set('as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield'.split(' ')),
  rust: new Set('as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
  sql: new Set('add all alter and as asc between by case check column create cross current_date current_time current_timestamp database default delete desc distinct drop else end exists false for foreign from full grant group having in index inner insert intersect into is join key left like limit not null on or order outer primary references right select set table then true union unique update values view when where with'.split(' ')),
};

type SyntaxFamily = keyof typeof KEYWORDS | 'plain';

function syntaxFamily(language: string): SyntaxFamily {
  const normalized = language.toLowerCase().replace(/^language-/, '');
  if (['py', 'python', 'python3'].includes(normalized)) return 'python';
  if (['bash', 'sh', 'shell', 'zsh', 'fish'].includes(normalized)) return 'shell';
  if (['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'node'].includes(normalized)) return 'javascript';
  if (['rs', 'rust'].includes(normalized)) return 'rust';
  if (['sql', 'postgres', 'postgresql', 'mysql', 'sqlite'].includes(normalized)) return 'sql';
  return 'plain';
}

function appendToken(tokens: CodeSyntaxToken[], kind: CodeSyntaxKind, text: string): void {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.kind === kind) {
    previous.text += text;
    return;
  }
  tokens.push({ kind, text });
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function scanLineComment(source: string, start: number): number {
  const end = source.indexOf('\n', start);
  return end === -1 ? source.length : end;
}

function scanBlockComment(source: string, start: number): number {
  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}

function scanString(source: string, start: number, family: SyntaxFamily): number {
  const quote = source[start] ?? '';
  const triple = family === 'python' && (quote === '"' || quote === "'")
    && source.slice(start, start + 3) === quote.repeat(3);
  let cursor = start + (triple ? 3 : 1);
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor = Math.min(source.length, cursor + 2);
      continue;
    }
    if (triple) {
      if (source.slice(cursor, cursor + 3) === quote.repeat(3)) return cursor + 3;
    } else if (source[cursor] === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
}

function scanNumber(source: string, start: number): number {
  let cursor = start;
  if (source[cursor] === '-') cursor += 1;
  if (source.startsWith('0x', cursor) || source.startsWith('0X', cursor)) {
    cursor += 2;
    while (/[0-9A-Fa-f_]/.test(source[cursor] ?? '')) cursor += 1;
    return cursor;
  }
  while (/[0-9_]/.test(source[cursor] ?? '')) cursor += 1;
  if (source[cursor] === '.') {
    cursor += 1;
    while (/[0-9_]/.test(source[cursor] ?? '')) cursor += 1;
  }
  if (source[cursor] === 'e' || source[cursor] === 'E') {
    cursor += 1;
    if (source[cursor] === '+' || source[cursor] === '-') cursor += 1;
    while (/[0-9_]/.test(source[cursor] ?? '')) cursor += 1;
  }
  return cursor;
}

/**
 * A bounded lexical pass for common agent-generated snippets. It deliberately
 * does not attempt to parse a language grammar: unknown constructs stay plain
 * source instead of being incorrectly transformed or executed.
 */
export function tokenizeCode(source: string, language = '', options: CodeSyntaxOptions = {}): CodeSyntaxResult {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxTokens = Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const visible = source.slice(0, maxChars);
  const family = syntaxFamily(language);
  const keywords = family === 'plain' ? undefined : KEYWORDS[family];
  const tokens: CodeSyntaxToken[] = [];
  let cursor = 0;

  while (cursor < visible.length && tokens.length < maxTokens) {
    const current = visible[cursor] ?? '';
    const next = visible[cursor + 1] ?? '';
    const shellOrPythonComment = (family === 'python' || family === 'shell') && current === '#';
    const sqlComment = family === 'sql' && current === '-' && next === '-';
    const slashComment = (family === 'javascript' || family === 'rust') && current === '/' && next === '/';
    if (shellOrPythonComment || sqlComment || slashComment) {
      const end = scanLineComment(visible, cursor);
      appendToken(tokens, 'comment', visible.slice(cursor, end));
      cursor = end;
      continue;
    }
    if ((family === 'javascript' || family === 'rust') && current === '/' && next === '*') {
      const end = scanBlockComment(visible, cursor);
      appendToken(tokens, 'comment', visible.slice(cursor, end));
      cursor = end;
      continue;
    }
    if (current === '"' || current === "'" || (current === '`' && family === 'javascript')) {
      const end = scanString(visible, cursor, family);
      appendToken(tokens, 'string', visible.slice(cursor, end));
      cursor = end;
      continue;
    }
    if (/\d/.test(current) || (current === '-' && /\d/.test(next))) {
      const end = scanNumber(visible, cursor);
      appendToken(tokens, 'number', visible.slice(cursor, Math.max(cursor + 1, end)));
      cursor = Math.max(cursor + 1, end);
      continue;
    }
    if (isIdentifierStart(current)) {
      let end = cursor + 1;
      while (isIdentifierPart(visible[end] ?? '')) end += 1;
      const word = visible.slice(cursor, end);
      appendToken(tokens, keywords?.has(word) ? 'keyword' : 'plain', word);
      cursor = end;
      continue;
    }
    appendToken(tokens, 'plain', current);
    cursor += 1;
  }

  if (cursor < visible.length) appendToken(tokens, 'plain', visible.slice(cursor));
  return {
    tokens,
    truncated: source.length > visible.length || cursor < visible.length,
    displayedChars: visible.length,
  };
}

interface HighlightedCodeProps {
  source: string;
  language?: string;
  ariaLabel: string;
  className?: string;
}

export function HighlightedCode({ source, language = '', ariaLabel, className }: HighlightedCodeProps): React.JSX.Element {
  const result = React.useMemo(() => tokenizeCode(source, language), [language, source]);
  return (
    <>
      {result.truncated ? <div className="content-budget-notice" role="status">Syntax highlighting is limited to the first {result.displayedChars.toLocaleString()} characters; the remaining source stays available below.</div> : null}
      <pre className={`content-code${className ? ` ${className}` : ''}`} aria-label={ariaLabel}>
        {result.tokens.map((token, index) => (
          token.kind === 'plain'
            ? <React.Fragment key={index}>{token.text}</React.Fragment>
            : <span className={`code-token code-token-${token.kind}`} key={`${token.kind}:${index}`}>{token.text}</span>
        ))}
        {source.slice(result.displayedChars)}
      </pre>
    </>
  );
}
