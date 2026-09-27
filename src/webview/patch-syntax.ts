import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_TOKENS,
  tokenizeCode,
  tokenizeCodeFragment,
  type CodeSyntaxKind,
  type CodeSyntaxOptions,
  type CodeSyntaxResult,
  type CodeSyntaxToken,
} from './code-syntax-core';

interface PatchLine {
  text: string;
  ending: string;
}

function splitLines(source: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    let end = cursor;
    while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1;
    let ending = '';
    if (source[end] === '\r' && source[end + 1] === '\n') ending = '\r\n';
    else if (source[end] === '\r' || source[end] === '\n') ending = source[end] ?? '';
    lines.push({ text: source.slice(cursor, end), ending });
    cursor = end + ending.length;
  }
  return lines;
}

function languageForPath(path: string): string {
  if (/\.tsx?$/i.test(path)) return 'typescript';
  if (/\.(?:jsx?|mjs|cjs)$/i.test(path)) return 'javascript';
  if (/\.ps1$/i.test(path)) return 'powershell';
  if (/\.(?:sh|bash|zsh)$/i.test(path)) return 'shell';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.rs$/i.test(path)) return 'rust';
  if (/\.sql$/i.test(path)) return 'sql';
  return '';
}

function isCompletePatch(source: string): boolean {
  return /^\s*apply_patch(?:\s|$)/.test(source)
    && /(?:^|\r?\n)\*\*\* Begin Patch\r?$/m.test(source)
    && /(?:^|\r?\n)\*\*\* End Patch\r?$/m.test(source);
}

export function tokenizePatch(source: string, options: CodeSyntaxOptions = {}): CodeSyntaxResult {
  if (!isCompletePatch(source)) return tokenizeCode(source, 'shell', options);

  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxTokens = Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const visible = source.slice(0, maxChars);
  const tokens: CodeSyntaxToken[] = [];
  let overflow = false;
  let inPatch = false;
  let inHunk = false;
  let language = '';

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

  const emitCode = (text: string, codeLanguage: string): void => {
    const result = tokenizeCodeFragment(text, codeLanguage, Math.max(1, maxTokens - tokens.length));
    for (const token of result.tokens) emit(token.kind, token.text);
    overflow ||= result.overflow;
  };

  for (const line of splitLines(visible)) {
    if (overflow) {
      emit('plain', line.text + line.ending);
      continue;
    }

    if (line.text === '*** Begin Patch') {
      inPatch = true;
      inHunk = false;
      emit('patch-meta', line.text);
    } else if (line.text === '*** End Patch') {
      inPatch = false;
      inHunk = false;
      emit('patch-meta', line.text);
    } else if (inPatch && /^\*\*\* (?:Update|Add|Delete) File: /.test(line.text)) {
      const isAddedFile = line.text.startsWith('*** Add File: ');
      language = languageForPath(line.text.replace(/^\*\*\* (?:Update|Add|Delete) File: /, ''));
      inHunk = isAddedFile;
      emit('patch-meta', line.text);
    } else if (inPatch && line.text.startsWith('@@')) {
      inHunk = true;
      emit('patch-meta', line.text);
    } else if (inHunk && /^[+\- ]/.test(line.text)) {
      const marker = line.text[0] === '+' ? 'patch-add' : line.text[0] === '-' ? 'patch-remove' : 'patch-context';
      emit(marker, line.text[0] ?? '');
      emitCode(line.text.slice(1), language);
    } else if (!inPatch) {
      emitCode(line.text, 'shell');
    } else {
      emit('patch-meta', line.text);
    }
    emit('plain', line.ending);
  }

  return {
    tokens,
    truncated: overflow || visible.length < source.length,
    displayedChars: visible.length,
  };
}
