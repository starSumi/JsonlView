import { isObject, own, stringAt } from './utils';

const MAX_BLOCKS = 32;
const MAX_CHARS = 128 * 1024;
const MAX_TOTAL_CHARS = 256 * 1024;
const MAX_HUNKS = 64;
const MAX_LINES = 512;

export interface ClaudeToolSection {
  title: string;
  kind: 'text' | 'code' | 'diff' | 'json';
  value: unknown;
  language?: string;
  truncated?: boolean;
}

export interface ClaudeToolBlock {
  value: Record<string, unknown>;
  index: number;
}

/** Physical rows can contain multiple tool blocks; never invent a cross-row link. */
export function findClaudeToolBlock(content: unknown, type: 'tool_use' | 'tool_result'): ClaudeToolBlock | undefined {
  if (!Array.isArray(content)) return undefined;
  for (let index = 0; index < Math.min(content.length, MAX_BLOCKS); index += 1) {
    const value = content[index];
    if (isObject(value) && own(value, 'type') === type) return { value, index };
  }
  return undefined;
}

interface BoundedDiff {
  source: string;
  truncated: boolean;
}

function safePath(path: unknown): string {
  return typeof path === 'string' ? path.slice(0, 1_024).replace(/[\r\n\u0000-\u001f]/g, ' ') : 'File';
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validate observed hunk fields, then serialize only the bounded patch window. */
export function claudeStructuredPatch(value: unknown, path: unknown): BoundedDiff | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  let source = '--- a/' + safePath(path) + '\n+++ b/' + safePath(path) + '\n';
  let truncated = value.length > MAX_HUNKS;
  let inspectedLines = 0;
  const append = (text: string): boolean => {
    const remaining = MAX_CHARS - source.length;
    source += text.slice(0, Math.max(0, remaining));
    if (text.length > remaining) truncated = true;
    return text.length <= remaining;
  };
  for (let index = 0; index < Math.min(value.length, MAX_HUNKS); index += 1) {
    const hunk = value[index];
    if (!isObject(hunk) || !['oldStart', 'oldLines', 'newStart', 'newLines'].every((key) => nonnegativeInteger(own(hunk, key)))) return undefined;
    const lines = own(hunk, 'lines');
    if (!Array.isArray(lines)) return undefined;
    if (!append('@@ -' + String(hunk.oldStart) + ',' + String(hunk.oldLines) + ' +' + String(hunk.newStart) + ',' + String(hunk.newLines) + ' @@\n')) break;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (inspectedLines >= MAX_LINES) return { source, truncated: true };
      inspectedLines += 1;
      const line = lines[lineIndex];
      if (typeof line !== 'string' || !/^[ +\-\\]/.test(line) || /[\r\n]/.test(line.slice(0, MAX_CHARS))) return undefined;
      const bounded = line.slice(0, MAX_CHARS);
      if (line.length > bounded.length) truncated = true;
      if (!append(bounded + '\n')) return { source, truncated: true };
    }
  }
  return { source, truncated };
}

/** Cell-local before/after preview; no whole-file diff or patch application. */
function cellDiff(before: string, after: string, path: unknown): BoundedDiff {
  const oldText = before.slice(0, MAX_CHARS).replace(/\r\n?/g, '\n');
  const newText = after.slice(0, MAX_CHARS).replace(/\r\n?/g, '\n');
  const oldLines = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const newLines = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  let truncated = before.length > MAX_CHARS || after.length > MAX_CHARS || oldLines.length + newLines.length > MAX_LINES;
  let source = '--- a/' + safePath(path) + '\n+++ b/' + safePath(path) + '\n@@ -' + (oldLines.length ? '1' : '0') + ',' + oldLines.length + ' +' + (newLines.length ? '1' : '0') + ',' + newLines.length + ' @@\n';
  let count = 0;
  for (const [marker, lines] of [['-', oldLines], ['+', newLines]] as const) {
    for (const line of lines) {
      if (count >= MAX_LINES || source.length >= MAX_CHARS) return { source, truncated: true };
      count += 1;
      const part = marker + line + '\n';
      const remaining = MAX_CHARS - source.length;
      source += part.slice(0, remaining);
      if (part.length > remaining) truncated = true;
    }
  }
  return { source, truncated };
}

/**
 * Shape-aware transcript projection. Opaque JSON candidates are not traversed
 * here; the caller must use its existing bounded JSON serializer. Raw remains
 * the authority for omitted text, unknown fields, and unrecognized results.
 */
export function claudeToolSections(record: Record<string, unknown>): ClaudeToolSection[] {
  const sections: ClaudeToolSection[] = [];
  let remaining = MAX_TOTAL_CHARS;
  const add = (title: string, kind: ClaudeToolSection['kind'], value: unknown, language?: string, truncated = false): void => {
    if (typeof value === 'string' && kind !== 'json') {
      const limit = Math.min(MAX_CHARS, remaining);
      const visible = value.slice(0, limit);
      remaining -= visible.length;
      sections.push({ title, kind, value: visible, ...(language ? { language } : {}), truncated: truncated || visible.length < value.length });
    } else if (value !== undefined) {
      sections.push({ title, kind, value, ...(language ? { language } : {}), truncated });
    }
  };
  const content = own(isObject(record.message) ? record.message : {}, 'content');
  const visible = Array.isArray(content) ? content.slice(0, MAX_BLOCKS) : [];
  for (let index = 0; index < visible.length; index += 1) {
    const block = visible[index];
    if (!isObject(block) || own(block, 'type') !== 'tool_use' || !isObject(block.input)) continue;
    const input = block.input;
    const name = stringAt(block, 'name');
    const suffix = visible.length > 1 ? ' ' + String(index + 1) : '';
    if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') add('Command' + suffix, 'code', input.command, name === 'PowerShell' ? 'powershell' : 'shell');
    if (name === 'Write' && typeof input.content === 'string') add('Proposed file content' + suffix, 'code', input.content);
    if (name === 'Edit') {
      if (typeof input.old_string === 'string') add('Old text' + suffix, 'code', input.old_string);
      if (typeof input.new_string === 'string') add('New text' + suffix, 'code', input.new_string);
    }
  }
  const results = visible.filter((block) => isObject(block) && own(block, 'type') === 'tool_result');
  if (!Object.hasOwn(record, 'toolUseResult')) return sections;
  const result = own(record, 'toolUseResult');
  if (results.length !== 1 || (Array.isArray(content) && content.length > MAX_BLOCKS) || !isObject(result)) {
    add('Tool metadata', 'json', result);
    return sections;
  }
  let recognized = false;
  const consumed = new Set<string>();
  const consume = (...keys: string[]): void => { for (const key of keys) consumed.add(key); recognized = true; };
  const file = isObject(result.file) ? result.file : undefined;
  if (result.type === 'text' && file && typeof file.content === 'string') {
    const start = nonnegativeInteger(file.startLine) && file.startLine > 0 ? file.startLine : undefined;
    const count = nonnegativeInteger(file.numLines) ? file.numLines : undefined;
    const range = start !== undefined ? ' · from line ' + start + (count !== undefined ? ' · ' + count + ' lines' : '') : '';
    add('Read · ' + safePath(file.filePath) + range, 'code', file.content);
    add('Read metadata', 'json', { filePath: file.filePath, startLine: file.startLine, numLines: file.numLines, totalLines: file.totalLines });
    consume('type', 'file');
  }
  const patch = claudeStructuredPatch(result.structuredPatch, result.filePath);
  if (patch) {
    add('Changes', 'diff', patch.source, 'diff', patch.truncated);
    consume('structuredPatch');
  }
  if (typeof result.filePath === 'string' && typeof result.content === 'string') {
    add((result.type === 'create' ? 'Created file · ' : 'Written file · ') + safePath(result.filePath), 'code', result.content);
    consume('content');
  }
  if (typeof result.oldString === 'string' && typeof result.newString === 'string') {
    if (!patch) {
      add('Old text', 'code', result.oldString);
      add('New text', 'code', result.newString);
    }
    consume('oldString', 'newString');
  }
  if (typeof result.old_source === 'string' && typeof result.new_source === 'string') {
    const diff = cellDiff(result.old_source, result.new_source, result.notebook_path);
    add('Cell changes', 'diff', diff.source, 'diff', diff.truncated);
    consume('old_source', 'new_source');
  }
  if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
    if (typeof result.stdout === 'string') add('stdout', 'text', result.stdout);
    if (typeof result.stderr === 'string') add('stderr', 'text', result.stderr);
    consume('stdout', 'stderr');
  }
  const sourceMetadata: Record<string, unknown> = {};
  for (const key of ['taskId', 'backgroundTaskId', 'interrupted'] as const) {
    if (Object.hasOwn(result, key)) sourceMetadata[key] = result[key];
  }
  if (Object.keys(sourceMetadata).length > 0) {
    add('Tool source metadata', 'json', sourceMetadata);
    consume('taskId', 'backgroundTaskId', 'interrupted');
  }
  if (Array.isArray(result.filenames)) {
    add('Files', 'json', result.filenames.slice(0, MAX_LINES), undefined, result.filenames.length > MAX_LINES);
    if (typeof result.content === 'string') { add('Matches', 'text', result.content); consumed.add('content'); }
    consume('filenames');
  }
  if (typeof result.diff === 'string' || typeof result.patch === 'string') {
    for (const key of ['diff', 'patch'] as const) {
      if (typeof result[key] === 'string') { add('Result ' + key, 'diff', result[key], 'diff'); consume(key); }
    }
  }
  if (!recognized) {
    add('Tool metadata', 'json', result);
  } else {
    const metadata: Record<string, unknown> = {};
    let count = 0;
    for (const key in result) {
      if (!Object.hasOwn(result, key)) continue;
      if (count >= MAX_BLOCKS) { add('Additional metadata', 'text', 'Additional fields remain available in Raw.', undefined, true); break; }
      count += 1;
      // Whole original/updated files are not needed to show a recorded patch.
      if (!consumed.has(key) && !['originalFile', 'original_file', 'updated_file'].includes(key)) metadata[key] = own(result, key);
    }
    if (Object.keys(metadata).length) add('Tool metadata', 'json', metadata);
  }
  return sections;
}
