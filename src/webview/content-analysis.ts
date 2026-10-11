export type ContentMode = 'auto' | 'text' | 'markdown' | 'json' | 'code';
export type DetectedContentKind = 'text' | 'markdown' | 'json';

export interface EmbeddedJsonCandidate {
  start: number;
  end: number;
  source: string;
  value: object | unknown[];
}

interface JsonScanFrame {
  opening: '{' | '[';
  start: number;
  end?: number;
  invalid: boolean;
  children: JsonScanFrame[];
}

const MAX_RICH_TEXT_CHARS = 64 * 1024;
const ANSI_ESCAPE_PATTERN = /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~])/g;
// A candidate is parsed at most once per structural frame and the aggregate
// source passed to JSON.parse is bounded. This keeps hostile nested input from
// turning the renderer into a quadratic parser while retaining useful fallback
// candidates inside malformed outer text.
const MAX_EMBEDDED_JSON_PARSE_CHARS = MAX_RICH_TEXT_CHARS * 8;

function objectOrArray(value: unknown): value is object | unknown[] {
  return value !== null && typeof value === 'object';
}

export function parseJsonObjectOrArray(source: string, depth = 0): object | unknown[] | undefined {
  const trimmed = source.trim();
  if (!trimmed || depth > 2) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // Tool bridges sometimes serialize a JSON document twice. Unwrap only a
    // quoted object/array so ordinary quoted text remains text.
    if (typeof parsed === 'string') {
      const nested = parsed.trim();
      if (nested !== trimmed && (nested.startsWith('{') || nested.startsWith('['))) {
        return parseJsonObjectOrArray(nested, depth + 1);
      }
      return undefined;
    }
    return objectOrArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Infer a conservative lexer for raw tool output. This is a signal-based
 * classifier, not a language parser; uncertain output stays selectable text.
 */
export function inferCodeLanguage(source: string, hint?: string): string | undefined {
  const explicit = hint?.trim().toLowerCase();
  if (explicit) return explicit;
  const normalized = source
    .replace(ANSI_ESCAPE_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+:\s?/, ''))
    .join('\n');
  const rustSignals = [
    /\b(?:use|pub|crate|mod|impl|struct|enum|trait)\s+[A-Za-z_]/,
    /\bfn\s+[A-Za-z_][\w]*\s*\(/,
    /\blet\s+(?:mut\s+)?[A-Za-z_][\w]*\s*=/,
    /\b(?:match|async|await)\b/,
    /::[A-Za-z_][\w]*/,
  ].filter((pattern) => pattern.test(normalized)).length;
  if (rustSignals >= 2) return 'rust';
  const shellSignals = [
    /^\s*#!.*\b(?:sh|bash|zsh|fish|pwsh|powershell)\b/m,
    /\b(?:if|then|fi|for|foreach|do|done|case|esac)\b/,
    /(?:^|\s)(?:Get-[A-Za-z]+|Set-[A-Za-z]+|Write-[A-Za-z]+|npm|pnpm|cargo|git)\b/m,
    /\$env:[A-Za-z_]|\bexport\s+[A-Za-z_][\w]*=/,
    /\[\s+-[a-zA-Z]+\s+[^\]]+\]/,
  ].filter((pattern) => pattern.test(normalized)).length;
  if (shellSignals >= 2) return 'shell';
  const pythonSignals = [
    /^\s*def\s+[A-Za-z_][\w]*\s*\(/m,
    /^\s*(?:from\s+\S+\s+)?import\s+\S+/m,
    /\b(?:elif|lambda|None|True|False)\b/,
  ].filter((pattern) => pattern.test(normalized)).length;
  if (pythonSignals >= 2) return 'python';
  const javascriptSignals = [
    /\b(?:const|let|var|function|import|export)\s+[A-Za-z_$]/,
    /\b(?:await|async)\b|=>/,
    /\b(?:console|process|require)\.[A-Za-z_]/,
  ].filter((pattern) => pattern.test(normalized)).length;
  if (javascriptSignals >= 2) return 'javascript';
  return undefined;
}

/**
 * Terminal-oriented producers commonly wrap every line in ANSI colour codes,
 * and tools such as rg -n prefix source lines with 42:. Those bytes are
 * meaningful in Text/Raw mode but prevent a Markdown heading/list from being
 * recognized. Normalize only the rich presentation path; never mutate the
 * value offered for copying or the exact source views.
 */
export function normalizeMarkdownSource(source: string): string {
  const withoutAnsi = source.replace(ANSI_ESCAPE_PATTERN, '');
  const lines = withoutAnsi.split(/\r?\n/);
  const numbered = lines.filter((line) => /^\s*\d+:\s?/.test(line));
  if (numbered.length < 2) return withoutAnsi;
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0 || numbered.length / nonEmpty.length < 0.5) return withoutAnsi;
  const unnumbered = lines.map((line) => line.replace(/^\s*\d+:\s?/, '')).join('\n');
  return hasMarkdownSignal(unnumbered) ? unnumbered : withoutAnsi;
}

/**
 * Find parseable object/array values embedded in prose. The scanner is
 * string-aware and bounded; braces in quoted strings or escaped JSON do not
 * terminate a candidate.
 */
export function extractEmbeddedJson(source: string): EmbeddedJsonCandidate[] {
  const roots: JsonScanFrame[] = [];
  const stack: JsonScanFrame[] = [];
  let inString = false;
  let escaped = false;

  // Build delimiter intervals once. A mismatch invalidates the active root and
  // resets the stack; completed descendants remain attached for fallback.
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor] ?? '';
    // Quotes in ordinary prose are not JSON string state. The previous
    // candidate scanner also reset its quote state for every opening token.
    if (stack.length === 0) {
      if (character === '{' || character === '[') {
        const frame: JsonScanFrame = { opening: character, start: cursor, invalid: false, children: [] };
        stack.push(frame);
      }
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
      const frame: JsonScanFrame = { opening: character, start: cursor, invalid: false, children: [] };
      stack.at(-1)?.children.push(frame);
      stack.push(frame);
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    const frame = stack.at(-1);
    if (!frame || frame.opening !== expected) {
      const root = stack[0];
      if (root) {
        root.invalid = true;
        roots.push(root);
      }
      stack.length = 0;
      inString = false;
      escaped = false;
      continue;
    }
    frame.end = cursor + 1;
    stack.pop();
    if (stack.length === 0) {
      roots.push(frame);
      inString = false;
      escaped = false;
    }
  }
  const incompleteRoot = stack[0];
  if (incompleteRoot && !roots.includes(incompleteRoot)) {
    incompleteRoot.invalid = true;
    roots.push(incompleteRoot);
  }

  const candidates: EmbeddedJsonCandidate[] = [];
  const maxCandidates = 4;
  let parseBudget = MAX_EMBEDDED_JSON_PARSE_CHARS;
  const pending = [...roots].reverse();
  while (pending.length > 0 && candidates.length < maxCandidates) {
    const frame = pending.pop();
    if (!frame) continue;
    let accepted = false;
    if (!frame.invalid && frame.end !== undefined) {
      const length = frame.end - frame.start;
      if (length <= MAX_RICH_TEXT_CHARS && length <= parseBudget) {
        parseBudget -= length;
        const candidateSource = source.slice(frame.start, frame.end);
        const value = parseJsonObjectOrArray(candidateSource);
        if (value !== undefined) {
          candidates.push({ start: frame.start, end: frame.end, source: candidateSource, value });
          accepted = true;
        }
      }
    }
    // A valid outer value owns its descendants. If it is malformed, continue
    // in source order so an embedded inner value can still be recovered.
    if (!accepted) {
      for (let index = frame.children.length - 1; index >= 0; index -= 1) {
        const child = frame.children[index];
        if (child) pending.push(child);
      }
    }
  }
  return candidates;
}

export function hasMarkdownSignal(source: string): boolean {
  const lines = source.split(/\r?\n/);
  let tableSeparator = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (/^#{1,6}\s+\S/.test(line) || /^(?:\x60{3,}|~{3,})\s*[A-Za-z0-9_+#.-]*\s*$/.test(line)) return true;
    if (/^(?:[-*+]\s+|\d+[.)]\s+|>\s?)/.test(line)) return true;
    if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(line)) return true;
    if (line.includes('|') && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1]?.trim() ?? '')) {
      tableSeparator = true;
    }
  }
  return tableSeparator || /\*\*[^*\n]+\*\*|\x60[^\x60\n]+\x60|\[[^\]\n]+\]\([^)\n]+\)/.test(source);
}

export function classifyContent(source: string): DetectedContentKind {
  const bounded = source.slice(0, MAX_RICH_TEXT_CHARS);
  if (parseJsonObjectOrArray(bounded) !== undefined && bounded.trim() === source.trim()) return 'json';
  const markdownSource = normalizeMarkdownSource(bounded);
  if (extractEmbeddedJson(bounded).length > 0 && !hasMarkdownSignal(markdownSource)) return 'json';
  return hasMarkdownSignal(markdownSource) ? 'markdown' : 'text';
}
