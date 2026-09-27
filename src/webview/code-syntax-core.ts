export type CodeSyntaxKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'operator'
  | 'variable'
  | 'command'
  | 'function'
  | 'type'
  | 'patch-meta'
  | 'patch-add'
  | 'patch-remove'
  | 'patch-context';

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

const MAX_FORMATTED_CHARS = 128 * 1024;
const MAX_FORMAT_INDENT = 32;

/**
 * Add readable line breaks to the small JavaScript snippets emitted by agent
 * tool calls. This is a display-only lexical pass: strings, comments, and
 * template literals are copied byte-for-byte, while the original source stays
 * available to the caller for Raw/Copy.
 */
export function formatJavaScriptForDisplay(source: string): string {
  if (!source || source.includes('\n')) {
    return source.replace(/\r\n?/g, '\n');
  }
  if (source.length > MAX_FORMATTED_CHARS) return source;

  let output = '';
  let indent = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  let pendingSpace = false;

  const writeIndent = (): void => {
    if (pendingSpace) {
      output += ' ';
      pendingSpace = false;
    }
    if (output.length === 0 || output.endsWith('\n')) {
      output += '  '.repeat(Math.min(MAX_FORMAT_INDENT, Math.max(0, indent)));
    }
  };
  const newline = (): void => {
    pendingSpace = false;
    if (!output.endsWith('\n')) output += '\n';
  };
  for (let index = 0; index < source.length; index += 1) {
    if (output.length + MAX_FORMAT_INDENT * 2 + 2 > MAX_FORMATTED_CHARS) return source;
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (lineComment) {
      writeIndent();
      output += current;
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      writeIndent();
      output += current;
      if (current === '*' && next === '/') {
        output += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      writeIndent();
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (current === '/' && next === '/') {
      writeIndent();
      output += '//';
      index += 1;
      lineComment = true;
      continue;
    }
    if (current === '/' && next === '*') {
      writeIndent();
      output += '/*';
      index += 1;
      blockComment = true;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      writeIndent();
      output += current;
      quote = current;
      escaped = false;
      continue;
    }

    if (current === '{') {
      writeIndent();
      output += '{';
      braceDepth += 1;
      if (next !== '}') {
        indent += 1;
        newline();
      }
      continue;
    }
    if (current === '}') {
      if (!output.endsWith('\n')) newline();
      indent = Math.max(0, indent - 1);
      writeIndent();
      output += '}';
      braceDepth = Math.max(0, braceDepth - 1);
      const after = next;
      if (after !== ';' && after !== ',' && after !== ')' && after !== ']' && after !== '.') newline();
      continue;
    }
    if (current === '(') {
      writeIndent();
      output += current;
      parenDepth += 1;
      continue;
    }
    if (current === ')') {
      writeIndent();
      output += current;
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (current === '[') {
      writeIndent();
      output += current;
      continue;
    }
    if (current === ']') {
      writeIndent();
      output += current;
      continue;
    }
    if (current === ';' && parenDepth === 0) {
      writeIndent();
      output += ';';
      newline();
      continue;
    }
    if (current === ',' && braceDepth > 0) {
      writeIndent();
      output += ',';
      newline();
      continue;
    }
    if (current === '\n') {
      newline();
      continue;
    }
    if (/\s/.test(current)) {
      const last = output.at(-1);
      if (output.length > 0 && last !== ' ' && last !== '\n') pendingSpace = true;
      continue;
    }
    writeIndent();
    output += current;
  }

  if (output.length > MAX_FORMATTED_CHARS) return source;
  return output.trimEnd();
}

export const DEFAULT_MAX_CHARS = 128 * 1024;
export const DEFAULT_MAX_TOKENS = 12_000;

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  python: new Set('and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield'.split(' ')),
  shell: new Set('case catch do done elif else esac fi for foreach function if in param return select then throw try until while export local readonly declare'.split(' ')),
  powershell: new Set('begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while'.split(' ')),
  javascript: new Set('as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield'.split(' ')),
  typescript: new Set('abstract any as asserts async await bigint boolean break case catch class const constructor continue declare debugger default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let module namespace never new null number object of package private protected public readonly require return set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield'.split(' ')),
  rust: new Set('as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
  sql: new Set('add all alter and as asc between by case check column create cross current_date current_time current_timestamp database default delete desc distinct drop else end exists false for foreign from full grant group having in index inner insert intersect into is join key left like limit not null on or order outer primary references right select set table then true union unique update values view when where with'.split(' ')),
};

type SyntaxFamily = keyof typeof KEYWORDS | 'plain';

function syntaxFamily(language: string): SyntaxFamily {
  const normalized = language.toLowerCase().replace(/^language-/, '');
  if (['py', 'python', 'python3'].includes(normalized)) return 'python';
  if (['bash', 'sh', 'shell', 'zsh', 'fish'].includes(normalized)) return 'shell';
  if (['pwsh', 'powershell', 'ps1'].includes(normalized)) return 'powershell';
  if (['ts', 'tsx', 'typescript'].includes(normalized)) return 'typescript';
  if (['js', 'jsx', 'javascript', 'node'].includes(normalized)) return 'javascript';
  if (['rs', 'rust'].includes(normalized)) return 'rust';
  if (['sql', 'postgres', 'postgresql', 'mysql', 'sqlite'].includes(normalized)) return 'sql';
  return 'plain';
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
      if (family === 'powershell' && source[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
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

function scanVariable(source: string, start: number, family: SyntaxFamily): number | undefined {
  if ((family !== 'shell' && family !== 'powershell') || source[start] !== '$') return undefined;
  if (source[start + 1] === '{') {
    const end = source.indexOf('}', start + 2);
    return end === -1 ? source.length : end + 1;
  }
  let end = start + 1;
  while (/[A-Za-z0-9_?@#$]/.test(source[end] ?? '')) end += 1;
  if (family === 'powershell' && source[end] === ':' && /[A-Za-z_]/.test(source[end + 1] ?? '')) {
    end += 1;
    while (/[A-Za-z0-9_]/.test(source[end] ?? '')) end += 1;
  }
  return end > start + 1 ? end : undefined;
}

function isOperator(character: string): boolean {
  return /[=+*/%<>!&|^~?:-]/.test(character);
}

function followsCallParen(source: string, start: number): boolean {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  return source[cursor] === '(';
}

function tokenizeLexical(source: string, family: SyntaxFamily, maxTokens: number): { tokens: CodeSyntaxToken[]; overflow: boolean } {
  const tokens: CodeSyntaxToken[] = [];
  const keywords = family === 'plain' ? undefined : KEYWORDS[family];
  let cursor = 0;
  let overflow = false;
  let declarationFollows = false;
  let commandExpected = family === 'shell' || family === 'powershell';

  const emit = (kind: CodeSyntaxKind, text: string): void => {
    if (!text) return;
    const previous = tokens.at(-1);
    if (previous?.kind === kind) {
      previous.text += text;
      return;
    }
    if (tokens.length < maxTokens) {
      tokens.push({ kind, text });
      return;
    }
    overflow = true;
    const last = tokens.at(-1);
    if (last) {
      last.kind = 'plain';
      last.text += text;
    }
  };

  while (cursor < source.length && !overflow) {
    const current = source[cursor] ?? '';
    const next = source[cursor + 1] ?? '';
    const shellComment = (family === 'shell' || family === 'powershell' || family === 'python') && current === '#';
    const sqlComment = family === 'sql' && current === '-' && next === '-';
    const slashComment = (family === 'javascript' || family === 'typescript' || family === 'rust') && current === '/' && next === '/';
    if (shellComment || sqlComment || slashComment) {
      const end = scanLineComment(source, cursor);
      emit('comment', source.slice(cursor, end));
      cursor = end;
      continue;
    }
    if ((family === 'javascript' || family === 'typescript' || family === 'rust') && current === '/' && next === '*') {
      const end = scanBlockComment(source, cursor);
      emit('comment', source.slice(cursor, end));
      cursor = end;
      continue;
    }
    if ((family === 'shell' || family === 'powershell') && current === '$') {
      const end = scanVariable(source, cursor, family);
      if (end !== undefined) {
        emit('variable', source.slice(cursor, end));
        commandExpected = false;
        cursor = end;
        continue;
      }
    }
    if (current === '"' || current === "'" || (current === '`' && (family === 'javascript' || family === 'typescript'))) {
      const end = scanString(source, cursor, family);
      emit('string', source.slice(cursor, end));
      commandExpected = false;
      cursor = end;
      continue;
    }
    if (/\d/.test(current) || (current === '-' && /\d/.test(next))) {
      const end = scanNumber(source, cursor);
      emit('number', source.slice(cursor, Math.max(cursor + 1, end)));
      commandExpected = false;
      cursor = Math.max(cursor + 1, end);
      continue;
    }
    if (isIdentifierStart(current)) {
      let end = cursor + 1;
      while (isIdentifierPart(source[end] ?? '')
        || (family === 'powershell' && source[end] === '-' && isIdentifierPart(source[end - 1] ?? '') && /[A-Za-z]/.test(source[end + 1] ?? ''))) end += 1;
      const word = source.slice(cursor, end);
      const isKeyword = keywords?.has(family === 'powershell' ? word.toLowerCase() : word) ?? false;
      const typeDeclaration = family === 'typescript' && declarationFollows;
      const functionCall = family !== 'plain' && !isKeyword && followsCallParen(source, end);
      const shellCommand = commandExpected && !isKeyword;
      emit(isKeyword ? 'keyword' : typeDeclaration ? 'type' : shellCommand ? 'command' : functionCall ? 'function' : 'plain', word);
      if (family === 'shell' || family === 'powershell') {
        commandExpected = isKeyword && ['do', 'else', 'elseif', 'if', 'then'].includes(word.toLowerCase());
      }
      declarationFollows = family === 'typescript' && ['class', 'enum', 'interface', 'type'].includes(word);
      cursor = end;
      continue;
    }
    if (/\s/.test(current)) {
      if (current === '\n' && (family === 'shell' || family === 'powershell')) commandExpected = true;
      emit('plain', current);
      cursor += 1;
      continue;
    }
    declarationFollows = false;
    if ((family === 'shell' || family === 'powershell') && current === ';') {
      emit('operator', current);
      commandExpected = true;
      cursor += 1;
      continue;
    }
    if (family !== 'plain' && isOperator(current)) {
      let end = cursor + 1;
      while (isOperator(source[end] ?? '')) end += 1;
      const operator = source.slice(cursor, end);
      emit('operator', operator);
      if ((family === 'shell' || family === 'powershell') && /^(?:\|+|&{1,2}|;)$/.test(operator)) commandExpected = true;
      cursor = end;
      continue;
    }
    if ((family === 'shell' || family === 'powershell') && (current === '{' || current === '}')) {
      emit('plain', current);
      commandExpected = current === '{';
      cursor += 1;
      continue;
    }
    emit('plain', current);
    cursor += 1;
  }

  if (cursor < source.length) {
    overflow = true;
    const rest = source.slice(cursor);
    const last = tokens.at(-1);
    if (last) {
      last.kind = 'plain';
      last.text += rest;
    } else if (maxTokens > 0) {
      tokens.push({ kind: 'plain', text: rest });
    }
  }
  return { tokens, overflow };
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
  const result = tokenizeLexical(visible, syntaxFamily(language), maxTokens);
  return {
    tokens: result.tokens,
    truncated: source.length > visible.length || result.overflow,
    displayedChars: visible.length,
  };
}

export function tokenizeCodeFragment(
  source: string,
  language: string,
  maxTokens: number,
): { tokens: CodeSyntaxToken[]; overflow: boolean } {
  return tokenizeLexical(source, syntaxFamily(language), maxTokens);
}
