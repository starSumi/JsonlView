import React, { useMemo } from 'react';
import type { AgentRowProjection } from '../shared/types';
import {
  isClaudeHistoryRecord,
  isClaudeJobTimelineRecord,
} from '../profiles/claude-record-strategy';
import {
  classifyCodexItem,
  normalizeCodexItemType,
} from '../profiles/codex-item-strategy';
import { CopyButton } from './copy-button';
import { stringifyJsonBounded } from './json-syntax';
import { classifyContent, ContentView, inferCodeLanguage, type ContentMode } from './content-view';
import { formatJavaScriptForDisplay, HighlightedCode } from './code-syntax';
import { DiffView } from './diff-view';

const MAX_TEXT = 8_000;
// Keep the first paint cheap, but allow an explicit Show full action to render
// ordinary structured tool results that are larger than the preview window.
// Truly huge values stay Raw-only and never get copied into the webview model.
const MAX_EXPANDED_STRUCTURED_TEXT = 256 * 1024;
const MAX_TEXT_ITEMS = 512;
const MAX_EXPANDED_TEXT_ITEMS = 10_000;
const MAX_TEXT_DEPTH = 4;
const MAX_DIFF_FILES = 128;
const MAX_METADATA = 8;

interface EventObject {
  [key: string]: unknown;
}

export interface EventPresentationSection {
  title: string;
  text?: string;
  fullText?: string;
  copyText?: string;
  truncated?: boolean;
  code?: string;
  language?: string;
  codeWrap?: boolean;
  richText?: boolean;
  previewOnly?: boolean;
  contentMode?: ContentMode;
  codeLanguage?: string;
}

export interface AgentEventPresentationModel {
  title: string;
  kind: string;
  metadata: Array<{ label: string; value: string }>;
  sections: EventPresentationSection[];
}

function objectOf(value: unknown): EventObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as EventObject
    : undefined;
}

interface TextExtraction {
  text?: string;
  truncated: boolean;
}

interface TextExtractionBudget {
  remainingChars: number;
  remainingItems: number;
  readonly maxDepth: number;
  truncated: boolean;
}

function extractText(
  value: unknown,
  options: { maxChars: number; maxItems: number; maxDepth?: number },
): TextExtraction {
  const budget: TextExtractionBudget = {
    remainingChars: options.maxChars,
    remainingItems: options.maxItems,
    maxDepth: options.maxDepth ?? MAX_TEXT_DEPTH,
    truncated: false,
  };
  const text = visitText(value, 0, budget);
  return {
    ...(text ? { text } : {}),
    truncated: budget.truncated,
  };
}

function visitText(value: unknown, depth: number, budget: TextExtractionBudget): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (depth > budget.maxDepth || budget.remainingItems <= 0) {
    budget.truncated = true;
    return undefined;
  }
  budget.remainingItems -= 1;

  if (typeof value === 'string') return takeText(value, budget);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return takeText(String(value), budget);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (budget.remainingChars <= 0 || budget.remainingItems <= 0) {
        budget.truncated = true;
        break;
      }
      const part = visitText(value[index], depth + 1, budget);
      if (!part) continue;
      if (parts.length > 0) {
        if (budget.remainingChars <= 0) {
          budget.truncated = true;
          break;
        }
        budget.remainingChars -= 1;
      }
      parts.push(part);
    }
    return parts.length ? parts.join('\n') : undefined;
  }
  const object = objectOf(value);
  if (!object) return undefined;
  for (const key of ['text', 'message', 'content', 'summary', 'output', 'result', 'value', 'reason', 'description']) {
    const candidate = visitText(object[key], depth + 1, budget);
    if (candidate) return candidate;
  }
  return undefined;
}

function takeText(value: string, budget: TextExtractionBudget): string | undefined {
  if (!value) return undefined;
  if (value.length <= budget.remainingChars) {
    budget.remainingChars -= value.length;
    return value;
  }
  const text = value.slice(0, budget.remainingChars);
  budget.remainingChars = 0;
  budget.truncated = true;
  return text || undefined;
}

function textOf(value: unknown): string | undefined {
  return extractText(value, { maxChars: MAX_TEXT, maxItems: MAX_TEXT_ITEMS }).text;
}

function boundedText(value: unknown): string | undefined {
  const result = extractText(value, { maxChars: MAX_TEXT, maxItems: MAX_TEXT_ITEMS });
  if (!result.text) return undefined;
  return result.truncated ? `${result.text}\n... [truncated]` : result.text;
}

function textSection(value: unknown): Pick<EventPresentationSection, 'text' | 'fullText' | 'truncated' | 'previewOnly'> {
  const result = extractText(value, {
    maxChars: MAX_EXPANDED_STRUCTURED_TEXT,
    maxItems: MAX_EXPANDED_TEXT_ITEMS,
  });
  if (!result.text) return {};
  const previewTruncated = result.truncated || result.text.length > MAX_TEXT;
  return {
    text: previewTruncated ? `${result.text.slice(0, MAX_TEXT)}\n... [preview truncated]` : result.text,
    ...(result.truncated ? {} : { fullText: result.text }),
    truncated: previewTruncated,
    previewOnly: result.truncated,
  };
}

function valueLabel(value: unknown): string | undefined {
  const text = boundedText(value);
  return text?.replaceAll('\n', ' ').trim();
}

function codeOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return boundedText(value);
  const result = stringifyJsonBounded(value, { maxChars: MAX_TEXT, maxNodes: 500, maxDepth: 10, maxChildren: 80 });
  return result.text;
}

interface CodeSectionValue {
  code: string;
  fullCode?: string;
  truncated: boolean;
  previewOnly: boolean;
}

function codeSectionValue(value: unknown): CodeSectionValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const expanded = value.slice(0, MAX_EXPANDED_STRUCTURED_TEXT);
    const previewOnly = value.length > expanded.length;
    const truncated = value.length > MAX_TEXT;
    return {
      code: truncated ? `${expanded.slice(0, MAX_TEXT)}\n... [preview truncated]` : expanded,
      ...(previewOnly ? {} : { fullCode: expanded }),
      truncated,
      previewOnly,
    };
  }
  const result = stringifyJsonBounded(value, { maxChars: MAX_TEXT, maxNodes: 500, maxDepth: 10, maxChildren: 80 });
  const expanded = result.truncated
    ? stringifyJsonBounded(value, {
      maxChars: MAX_EXPANDED_STRUCTURED_TEXT,
      maxNodes: 10_000,
      maxDepth: 32,
      maxChildren: MAX_TEXT_ITEMS,
    })
    : result;
  return {
    code: result.text,
    ...(expanded.truncated ? {} : { fullCode: expanded.text }),
    truncated: result.truncated,
    previewOnly: expanded.truncated,
  };
}

function contextCode(payload: EventObject): string | undefined {
  const context: EventObject = {};
  const hidden = /^(?:base_)?instructions?$|^(?:history|context_window|conversation|prompt)$/i;
  let count = 0;
  for (const key in payload) {
    if (!Object.hasOwn(payload, key) || hidden.test(key)) continue;
    if (count >= 12) break;
    const value = payload[key];
    if (typeof value === 'string' && value.length > 320) {
      context[key] = `${value.slice(0, 320)}...`;
    } else if (typeof value === 'object' && value !== null) {
      const label = textOf(value);
      context[key] = label && label.length <= 320 ? label : '[object]';
    } else {
      context[key] = value;
    }
    count += 1;
  }
  return codeOf(context);
}

function isBoundedContentBlockArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const inspected = Math.min(value.length, MAX_TEXT_ITEMS);
  for (let index = 0; index < inspected; index += 1) {
    const object = objectOf(value[index]);
    if (object === undefined || typeof object.type !== 'string'
      || (typeof object.text !== 'string' && typeof object.content !== 'string')) return false;
  }
  // Do not classify a high-cardinality array from a prefix. The JSON renderer
  // can project it safely without touching the uninspected tail.
  return value.length <= inspected;
}

function someArrayItemWithinBudget(
  value: readonly unknown[],
  predicate: (item: unknown) => boolean,
  maxItems = MAX_EXPANDED_TEXT_ITEMS,
): boolean {
  const inspected = Math.min(value.length, maxItems);
  for (let index = 0; index < inspected; index += 1) {
    if (predicate(value[index])) return true;
  }
  return false;
}

function firstString(objects: EventObject[], keys: string[]): string | undefined {
  for (const object of objects) {
    for (const key of keys) {
      const value = valueLabel(object[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function isAgentMarkdownText(
  item: EventObject | undefined,
  payload: EventObject,
  content: unknown,
  profile?: AgentRowProjection,
): boolean {
  const normalizedItemType = normalizeCodexItemType(typeof item?.type === 'string' ? item.type : undefined);
  if (item?.type === 'AgentMessage' || normalizedItemType === 'agent_message') {
    if (typeof content === 'string') return true;
    if (Array.isArray(content) && someArrayItemWithinBudget(content, (block) => {
      const object = objectOf(block);
      return typeof object?.type === 'string'
        && object.type.toLowerCase() === 'text'
        && typeof object.text === 'string';
    })) return true;
  }
  if (normalizedItemType === 'plan') return typeof content === 'string';

  // Responses API messages are role-bearing: assistant output may contain
  // Markdown, while user/developer prompts should remain selectable source
  // text unless the user explicitly chooses the Markdown mode.
  if (normalizedItemType === 'message') {
    const role = valueLabel(item?.role ?? payload.role)?.toLowerCase();
    const blocks = Array.isArray(content) ? content : [];
    return role === 'assistant' && someArrayItemWithinBudget(blocks, (block) => {
      const object = objectOf(block);
      const type = typeof object?.type === 'string' ? object.type.toLowerCase() : '';
      return (type === 'text' || type === 'output_text') && typeof object?.text === 'string';
    });
  }

  // Claude's assistant text blocks are Markdown in the native transcript.
  // Job timelines use a separate `{at,state,text}` envelope; only that
  // explicit shape opts its text into Markdown, avoiding a blanket rule for
  // arbitrary application fields named `text`.
  if (profile?.profileId !== 'claude-code-session') return false;
  const timelineText = own(payload, 'text');
  if (isClaudeJobTimelineRecord(payload) && typeof timelineText === 'string' && timelineText.length > 0) return true;
  const message = objectOf(payload.message);
  const role = typeof message?.role === 'string' ? message.role.toLowerCase() : undefined;
  const blocks = message?.content;
  return role === 'assistant' && Array.isArray(blocks)
    && someArrayItemWithinBudget(blocks, (block) => objectOf(block)?.type === 'text');
}

function own(object: EventObject, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function presentationProduct(profile?: AgentRowProjection): string {
  if (profile?.profileId === 'codex-rollout' || profile?.profileId === 'codex-exec-jsonl' || profile?.profileId === 'codex-trace') return 'Codex';
  if (profile?.profileId === 'claude-code-session') return 'Claude';
  return 'Agent';
}

function isEventEnvelope(value: EventObject, profile?: AgentRowProjection): boolean {
  if (profile?.profileId && profile.profileId !== 'generic') return true;
  const type = valueLabel(value.type);
  if (type && /(?:response_item|event_msg|session_meta|turn_context|thread_item|turn_item|tool|message|span|trace)/i.test(type)) return true;
  // Generic datasets often carry their human-readable payload in a top-level
  // text/content/message field without an event discriminator. The additional
  // training-data shapes are likewise explicit; arbitrary scalar columns do
  // not become rich-document panels.
  return profile?.profileId === 'generic'
    && (
      ['text', 'content', 'message'].some((key) => textOf(own(value, key)) !== undefined)
      || Array.isArray(value.messages)
      || Array.isArray(value.conversations)
      || Array.isArray(value.chosen_messages)
      || Array.isArray(value.rejected_messages)
      || textOf(own(value, 'instruction')) !== undefined
      || textOf(own(value, 'output')) !== undefined
      || (textOf(own(value, 'chosen')) !== undefined && textOf(own(value, 'rejected')) !== undefined)
    );
}

function valueAtPath(root: EventObject | undefined, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const object = objectOf(current);
    if (!object) return undefined;
    current = own(object, key);
  }
  return current;
}

function addTextCandidate(
  sections: EventPresentationSection[],
  title: string,
  value: unknown,
  richText = false,
): void {
  const content = textSection(value);
  if (content.text === undefined || sections.some((section) => section.title === title)) return;
  sections.push({ title, ...content, richText });
}

function addOutputCandidate(
  sections: EventPresentationSection[],
  title: string,
  value: unknown,
): void {
  if (value === undefined || sections.some((section) => section.title === title)) return;
  // Structured tool responses should remain inspectable as JSON instead of
  // being flattened through textOf(). Arrays of content blocks are the one
  // exception: their text projection is more useful as a readable transcript.
  const contentBlockArray = isBoundedContentBlockArray(value);
  if (objectOf(value) || (Array.isArray(value) && !contentBlockArray)) {
    addCodeCandidate(sections, title, value, 'json');
    return;
  }
  const content = textSection(value);
  if (content.text === undefined) return;
  const fullText = content.fullText ?? content.text;
  const detected = classifyContent(fullText);
  const codeLanguage = detected === 'text' ? inferCodeLanguage(fullText) : undefined;
  sections.push({
    title,
    ...content,
    richText: true,
    ...(detected === 'json' ? { contentMode: 'json' as const } : {}),
    ...(detected === 'markdown' ? { contentMode: 'markdown' as const } : {}),
    ...(detected === 'text' ? { contentMode: 'auto' as const } : {}),
    ...(codeLanguage ? { contentMode: 'code', codeLanguage } : {}),
  });
}

function addCommandOutputCandidate(
  sections: EventPresentationSection[],
  title: string,
  value: unknown,
): void {
  if (value === undefined || sections.some((section) => section.title === title)) return;
  const content = textSection(value);
  if (content.text === undefined) return;
  const fullText = content.fullText ?? content.text;
  const detected = classifyContent(fullText);
  const codeLanguage = detected === 'text' ? inferCodeLanguage(fullText) : undefined;
  sections.push({
    title,
    ...content,
    richText: true,
    ...(detected === 'json' ? { contentMode: 'json' as const } : {}),
    ...(detected === 'markdown' ? { contentMode: 'markdown' as const } : {}),
    ...(detected === 'text' ? { contentMode: 'auto' as const } : {}),
    ...(codeLanguage ? { contentMode: 'code', codeLanguage } : {}),
  });
}

function addCodeCandidate(
  sections: EventPresentationSection[],
  title: string,
  value: unknown,
  language?: string,
): void {
  if (value === undefined || sections.some((section) => section.title === title)) return;
  const rendered = codeSectionValue(value);
  if (rendered !== undefined) {
    sections.push({
      title,
      code: rendered.code,
      ...(rendered.fullCode === undefined ? {} : { fullText: rendered.fullCode }),
      truncated: rendered.truncated,
      previewOnly: rendered.previewOnly,
      ...(language ? { language } : {}),
    });
  }
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./\\:=@%+,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

interface FormattedCommand {
  text: string;
  truncated: boolean;
}

function formatCommandArguments(value: readonly unknown[]): FormattedCommand | undefined {
  if (value.length === 0) return { text: '', truncated: false };
  const executable = value[0];
  if (typeof executable !== 'string') return undefined;
  const powerShell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(executable)
    || /(?:pwsh|powershell)(?:\.exe)?$/i.test(executable);
  const continuation = powerShell ? '`' : '\\';
  const first = powerShell && /\s/.test(executable)
    ? `& ${shellQuoteForDisplay(executable)}`
    : shellQuoteForDisplay(executable);
  let output = first.slice(0, MAX_EXPANDED_STRUCTURED_TEXT);
  let truncated = first.length > output.length;
  let commandArgument = false;
  const inspected = Math.min(value.length, MAX_EXPANDED_TEXT_ITEMS);
  for (let index = 1; index < inspected && !truncated; index += 1) {
    const argument = value[index];
    if (typeof argument !== 'string') return undefined;
    const isCommandFlag = /^-?-?command$/i.test(argument) || argument === '/c' || argument === '-c';
    const boundedArgument = argument.slice(0, MAX_EXPANDED_STRUCTURED_TEXT);
    const line = commandArgument
      ? `  ${boundedArgument.replace(/\r\n?/g, '\n').replaceAll('\n', '\n  ')}`
      : `  ${shellQuoteForDisplay(boundedArgument)}`;
    const prefix = ` ${continuation}\n`;
    const remaining = MAX_EXPANDED_STRUCTURED_TEXT - output.length - prefix.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    output += prefix + line.slice(0, remaining);
    if (argument.length > boundedArgument.length || line.length > remaining) truncated = true;
    if (commandArgument) {
      commandArgument = false;
    } else {
      commandArgument = isCommandFlag;
    }
  }
  if (value.length > inspected) truncated = true;
  return { text: output, truncated };
}

function addCommandCandidate(sections: EventPresentationSection[], value: unknown): void {
  if (value === undefined || sections.some((section) => section.title === 'Command')) return;
  if (Array.isArray(value)) {
    const formatted = formatCommandArguments(value);
    if (formatted === undefined) {
      addCodeCandidate(sections, 'Command', value);
      return;
    }
    const display = formatted.text;
    const boundedSource = stringifyJsonBounded(value, {
      maxChars: MAX_EXPANDED_STRUCTURED_TEXT,
      maxNodes: 10_000,
      maxDepth: 32,
      maxChildren: MAX_TEXT_ITEMS,
    });
    const code = display.length > MAX_TEXT ? `${display.slice(0, MAX_TEXT)}\n... [preview truncated]` : display;
    sections.push({
      title: 'Command',
      code,
      ...(!formatted.truncated ? { fullText: display } : {}),
      copyText: boundedSource.text,
      truncated: formatted.truncated || display.length > MAX_TEXT || boundedSource.truncated,
      previewOnly: formatted.truncated || boundedSource.truncated,
      language: 'shell',
      codeWrap: true,
    });
    return;
  }
  if (typeof value === 'string') {
    addCodeCandidate(sections, 'Command', value, 'shell');
    const section = sections.find((candidate) => candidate.title === 'Command');
    if (section) section.codeWrap = true;
    return;
  }
  addCodeCandidate(sections, 'Command', value);
}

function addJavaScriptCandidate(sections: EventPresentationSection[], title: string, value: string): void {
  const boundedSource = value.slice(0, MAX_EXPANDED_STRUCTURED_TEXT);
  const sourceTruncated = boundedSource.length < value.length;
  const formatted = formatJavaScriptForDisplay(boundedSource);
  const sectionValue = codeSectionValue(formatted);
  if (!sectionValue) return;
  sections.push({
    title,
    code: sectionValue.code,
    ...(!sourceTruncated && sectionValue.fullCode !== undefined ? { fullText: sectionValue.fullCode } : {}),
    copyText: value,
    truncated: sourceTruncated || sectionValue.truncated,
    previewOnly: sourceTruncated || sectionValue.previewOnly,
    language: 'javascript',
    codeWrap: true,
  });
}

interface FileChangeEntry {
  path: string;
  change: EventObject;
}

interface BoundedFileChangeEntries {
  entries: FileChangeEntry[];
  truncated: boolean;
}

function fileChangeEntries(value: unknown): BoundedFileChangeEntries | undefined {
  if (Array.isArray(value)) {
    const entries: FileChangeEntry[] = [];
    const count = Math.min(value.length, MAX_DIFF_FILES);
    for (let index = 0; index < count; index += 1) {
      const rawChange = value[index];
      const change = objectOf(rawChange);
      if (!change) return undefined;
      const path = [change.path, change.file_path, change.filename].find((candidate): candidate is string => typeof candidate === 'string');
      entries.push({ path: path ?? `File ${index + 1}`, change });
    }
    return { entries, truncated: value.length > count };
  }

  const object = objectOf(value);
  if (!object) return undefined;
  if (typeof object.unified_diff === 'string' || typeof object.diff === 'string' || typeof object.type === 'string' || typeof object.kind === 'string') {
    const path = [object.path, object.file_path, object.filename].find((candidate): candidate is string => typeof candidate === 'string');
    return { entries: [{ path: path ?? 'File change', change: object }], truncated: false };
  }

  const entries: FileChangeEntry[] = [];
  let truncated = false;
  for (const path in object) {
    if (!Object.hasOwn(object, path)) continue;
    if (entries.length >= MAX_DIFF_FILES) {
      truncated = true;
      break;
    }
    const rawChange = object[path];
    const change = objectOf(rawChange);
    if (!change) return undefined;
    entries.push({ path, change });
  }
  return { entries, truncated };
}

function filePathHeader(path: string): string {
  return `file: ${path.replace(/[\r\n]/g, ' ').slice(0, 1_024)}`;
}

function contentDiff(change: EventObject, path: string): { source: string; truncated: boolean } | undefined {
  const type = valueLabel(change.type ?? change.kind)?.toLowerCase();
  const content = own(change, 'content');
  if ((type !== 'add' && type !== 'delete') || typeof content !== 'string') return undefined;

  const limited = content.slice(0, MAX_EXPANDED_STRUCTURED_TEXT);
  const truncated = content.length > limited.length;
  const normalized = limited.replace(/\r\n?/g, '\n');
  const endsWithNewline = !truncated && normalized.endsWith('\n');
  const lines = normalized.length === 0 ? [] : normalized.split('\n');
  if (endsWithNewline) lines.pop();
  const count = lines.length;
  const normalizedPath = path.replace(/[\r\n]/g, ' ').slice(0, 1_024);
  const header = type === 'add'
    ? `--- /dev/null\n+++ b/${normalizedPath}\n@@ -0,0 +1,${count} @@\n`
    : `--- a/${normalizedPath}\n+++ /dev/null\n@@ -1,${count} +0,0 @@\n`;
  const marker = type === 'add' ? '+' : '-';
  const body = lines.map((line) => `${marker}${line}`).join('\n');
  return { source: `${header}${body}${endsWithNewline && body ? '\n' : ''}`, truncated };
}

function fileChangeDiff(value: unknown): { source: string; truncated: boolean } | undefined {
  const result = fileChangeEntries(value);
  if (!result?.entries.length) return undefined;
  const entries = result.entries;

  const chunks: string[] = [];
  let size = 0;
  let truncated = result.truncated;
  const append = (chunk: string): boolean => {
    const remaining = MAX_EXPANDED_STRUCTURED_TEXT - size;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    const visible = chunk.slice(0, remaining);
    chunks.push(visible);
    size += visible.length;
    if (visible.length < chunk.length) truncated = true;
    return visible.length === chunk.length;
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const rawDiff = typeof entry.change.unified_diff === 'string'
      ? entry.change.unified_diff
      : typeof entry.change.diff === 'string'
        ? entry.change.diff
        : undefined;
    const content = rawDiff === undefined ? contentDiff(entry.change, entry.path) : undefined;
    if (rawDiff === undefined && content === undefined) return undefined;
    if (index > 0 && !append('\n\n')) break;
    if (!append(`${filePathHeader(entry.path)}\n`)) break;
    if (rawDiff !== undefined) {
      if (!append(rawDiff)) break;
    } else if (content !== undefined) {
      if (content.truncated) truncated = true;
      if (!append(content.source)) break;
    }
  }

  const source = chunks.join('');
  return source ? { source, truncated } : undefined;
}

function addDiffCandidate(sections: EventPresentationSection[], title: string, value: unknown): boolean {
  const diff = fileChangeDiff(value);
  if (!diff || sections.some((section) => section.title === title)) return false;
  const code = diff.source.length > MAX_TEXT
    ? `${diff.source.slice(0, MAX_TEXT)}\n... [preview truncated]`
    : diff.source;
  const hasFullSource = !diff.truncated && diff.source.length <= MAX_EXPANDED_STRUCTURED_TEXT;
  sections.push({
    title,
    code,
    ...(hasFullSource ? { fullText: diff.source } : {}),
    truncated: diff.truncated || diff.source.length > MAX_TEXT,
    previewOnly: !hasFullSource,
    language: 'diff',
  });
  return true;
}

function appendClaudeContentBlock(
  sections: EventPresentationSection[],
  block: unknown,
  title: string,
  role: string | undefined,
): void {
  if (typeof block === 'string') {
    addTextCandidate(sections, title, block, role === 'assistant');
    return;
  }
  const object = objectOf(block);
  if (!object) {
    addCodeCandidate(sections, title, block, 'json');
    return;
  }

  const type = valueLabel(object.type)?.toLowerCase();
  if (type === 'text' || type === 'thinking' || type === 'redacted_thinking') {
    const text = own(object, 'text') ?? own(object, 'thinking');
    if (typeof text === 'string') {
      sections.push({
        title,
        ...textSection(text),
        richText: role === 'assistant' && type === 'text',
      });
      return;
    }
  }

  if (type === 'tool_result' || type === 'web_search_tool_result') {
    const result = own(object, 'content') ?? own(object, 'result') ?? own(object, 'output');
    if (Array.isArray(result)) {
      const count = Math.min(result.length, 32);
      for (let index = 0; index < count; index += 1) {
        appendClaudeContentBlock(sections, result[index], `${title} · ${String(index + 1)}`, role);
      }
    } else if (typeof result === 'string') {
      addTextCandidate(sections, title, result, false);
    } else if (result !== undefined) {
      addCodeCandidate(sections, title, result, 'json');
    } else {
      addCodeCandidate(sections, title, object, 'json');
    }
    return;
  }

  if (type === 'tool_use' || type === 'server_tool_use') {
    const input = own(object, 'input') ?? own(object, 'arguments');
    addCodeCandidate(sections, title, input ?? object, 'json');
    return;
  }

  const text = textOf(object);
  let textOnlyShape = true;
  let textOnlyFields = 0;
  for (const key in object) {
    if (!Object.hasOwn(object, key)) continue;
    textOnlyFields += 1;
    if (textOnlyFields > 2 || (key !== 'type' && key !== 'text')) {
      textOnlyShape = false;
      break;
    }
  }
  if (text !== undefined && textOnlyShape) {
    addTextCandidate(sections, title, text, role === 'assistant');
    return;
  }
  addCodeCandidate(sections, title, object, 'json');
}

function claudeMessageSections(
  payload: EventObject,
  profile?: AgentRowProjection,
): EventPresentationSection[] {
  if (profile?.profileId !== 'claude-code-session') return [];
  const message = objectOf(payload.message);
  if (!message || !Object.hasOwn(message, 'content')) return [];
  const role = valueLabel(message.role)?.toLowerCase();
  const content = own(message, 'content');
  if (!Array.isArray(content)) {
    if (typeof content === 'string') {
      return [{ title: 'Message', ...textSection(content), richText: role === 'assistant' }];
    }
    const sections: EventPresentationSection[] = [];
    addCodeCandidate(sections, 'Content', content, 'json');
    return sections;
  }
  if (content.length === 0) {
    const sections: EventPresentationSection[] = [];
    addCodeCandidate(sections, 'Content', content, 'json');
    return sections;
  }
  const sections: EventPresentationSection[] = [];
  const singleTextBlock = content.length === 1
    && objectOf(content[0])?.type === 'text';
  const visibleBlocks = Math.min(content.length, 32);
  for (let index = 0; index < visibleBlocks; index += 1) {
    const block = content[index];
    const object = objectOf(block);
    const type = valueLabel(object?.type)?.toLowerCase() ?? 'content';
    const title = singleTextBlock
      ? 'Message'
      : type === 'tool_result'
        ? `Tool result${content.length > 1 ? ` ${String(index + 1)}` : ''}`
        : type === 'tool_use' || type === 'server_tool_use'
          ? `Tool input${content.length > 1 ? ` ${String(index + 1)}` : ''}`
          : `${type.replaceAll('_', ' ')}${content.length > 1 ? ` ${String(index + 1)}` : ''}`;
    appendClaudeContentBlock(sections, block, title, role);
  }
  if (content.length > 32) {
    sections.push({
      title: 'Additional content blocks',
      code: JSON.stringify({ omittedBlocks: content.length - 32 }, null, 2),
      truncated: true,
      previewOnly: true,
      language: 'json',
    });
  }
  return sections;
}

/**
 * These are deliberately explicit Codex-owned paths. A generic `text` key is
 * not enough evidence to turn arbitrary application data into Markdown.
 */
function codexContextSections(
  envelopeType: string | undefined,
  payload: EventObject,
): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  if (envelopeType === 'world_state') {
    const fields: Array<{ title: string; path: string[]; richText: boolean }> = [
      { title: 'AGENTS.md', path: ['state', 'agents_md', 'text'], richText: true },
      { title: 'Host skills', path: ['state', 'host_skills', 'body'], richText: true },
      { title: 'Orchestrator skills', path: ['state', 'orchestrator_skills', 'body'], richText: true },
      { title: 'Permission instructions', path: ['state', 'permissions', 'instructions'], richText: true },
      { title: 'Collaboration instructions', path: ['state', 'collaboration_mode', 'settings', 'developer_instructions'], richText: true },
      { title: 'Developer instructions', path: ['state', 'developer_instructions'], richText: true },
      { title: 'Managed developer instructions', path: ['state', 'managed_developer_instructions'], richText: true },
      { title: 'Multi-agent usage hint', path: ['state', 'multi_agent_usage_hint'], richText: false },
      { title: 'Skills', path: ['state', 'skills', 'body'], richText: true },
      { title: 'Skills instructions', path: ['state', 'skills', 'instructions'], richText: true },
      { title: 'Context window guidance', path: ['state', 'context_window_guidance'], richText: false },
    ];
    for (const field of fields) addTextCandidate(sections, field.title, valueAtPath(payload, field.path), field.richText);
  } else if (envelopeType === 'thread_settings_applied') {
    const fields: Array<{ title: string; path: string[] }> = [
      { title: 'Developer instructions', path: ['thread_settings', 'collaboration_mode', 'settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['thread_settings', 'settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['thread_settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['collaboration_mode', 'settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['developer_instructions'] },
      { title: 'Instructions', path: ['instructions'] },
    ];
    for (const field of fields) addTextCandidate(sections, field.title, valueAtPath(payload, field.path), true);
  } else if (envelopeType === 'session_meta') {
    addTextCandidate(sections, 'Base instructions', valueAtPath(payload, ['base_instructions']), true);
  } else if (envelopeType === 'compacted') {
    addTextCandidate(sections, 'Compaction message', own(payload, 'message'), true);
  } else if (envelopeType === 'inter_agent_communication') {
    addTextCandidate(sections, 'Agent message', own(payload, 'content'), true);
  } else if (envelopeType === 'task_complete' || envelopeType === 'turn_complete') {
    // Codex keeps the terminal turn message beside the lifecycle envelope,
    // rather than wrapping it in a response-item content block.
    addTextCandidate(sections, 'Last agent message', own(payload, 'last_agent_message'), true);
    addTextCandidate(sections, 'Error', own(payload, 'error'), true);
    const timing: EventObject = {};
    for (const key of ['started_at', 'completed_at', 'duration_ms', 'time_to_first_token_ms']) {
      if (own(payload, key) !== undefined) timing[key] = own(payload, key);
    }
    if (Object.keys(timing).length > 0) addCodeCandidate(sections, 'Timing', timing, 'json');
  }
  return sections;
}

function codexItemSections(
  item: EventObject | undefined,
  normalizedType: string | undefined,
): EventPresentationSection[] {
  if (!item || !normalizedType) return [];
  const sections: EventPresentationSection[] = [];
  switch (normalizedType) {
    case 'reasoning':
      addTextCandidate(sections, 'Reasoning summary', own(item, 'summary_text'), true);
      addTextCandidate(sections, 'Reasoning content', own(item, 'raw_content'), true);
      break;
    case 'command_execution':
      addCommandCandidate(sections, own(item, 'command'));
      for (const key of ['stdout', 'stderr', 'aggregated_output', 'formatted_output']) {
        addCommandOutputCandidate(sections, key.replaceAll('_', ' '), own(item, key));
      }
      break;
    case 'file_change':
      if (!addDiffCandidate(sections, 'Changes', own(item, 'changes'))) {
        if (typeof own(item, 'unified_diff') === 'string' || typeof own(item, 'diff') === 'string') {
          addDiffCandidate(sections, 'Changes', item);
        } else {
          addCodeCandidate(sections, 'Changes', own(item, 'changes'));
        }
      }
      addTextCandidate(sections, 'stdout', own(item, 'stdout'), true);
      addTextCandidate(sections, 'stderr', own(item, 'stderr'), true);
      break;
    case 'mcp_tool_call':
    case 'dynamic_tool_call':
      addCodeCandidate(sections, 'Arguments', own(item, 'arguments'));
      addTextCandidate(sections, 'Result', own(item, 'result'));
      addTextCandidate(sections, 'Error', own(item, 'error'));
      addTextCandidate(sections, 'Output', own(item, 'content_items'));
      break;
    case 'collab_agent_tool_call':
    case 'collab_tool_call':
    case 'sub_agent_activity':
      addTextCandidate(sections, 'Prompt', own(item, 'prompt'), true);
      break;
    case 'plan':
      addTextCandidate(sections, 'Plan', own(item, 'text'), true);
      break;
    case 'hook_prompt':
      addTextCandidate(sections, 'Prompt', own(item, 'fragments'), true);
      break;
    case 'extension':
      addTextCandidate(sections, 'Query', own(item, 'query'));
      addCodeCandidate(sections, 'Action', own(item, 'action'));
      addTextCandidate(sections, 'Results', own(item, 'results'));
      addTextCandidate(sections, 'Result', own(item, 'result'));
      addTextCandidate(sections, 'Output', own(item, 'output'));
      break;
    case 'image_view':
      addTextCandidate(sections, 'Path', own(item, 'path'));
      break;
    case 'function_call_output':
      addOutputCandidate(sections, 'Tool result', own(item, 'output'));
      break;
    default:
      break;
  }
  return sections;
}

function codexResponseItemSections(
  itemType: string | undefined,
  item: EventObject,
): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  switch (itemType) {
    case 'custom_tool_call': {
      const name = valueLabel(own(item, 'name'));
      const input = own(item, 'input');
      if ((name === 'exec' || name === 'js_repl') && typeof input === 'string') {
        addJavaScriptCandidate(sections, `JavaScript · ${name}`, input);
      } else {
        addTextCandidate(sections, name ? `Freeform input · ${name}` : 'Freeform input', input);
      }
      break;
    }
    case 'custom_tool_call_output':
    case 'function_call_output':
      addOutputCandidate(sections, 'Tool result', own(item, 'output'));
      break;
    case 'function_call':
      addCodeCandidate(sections, 'Arguments', own(item, 'arguments'), 'json');
      break;
    case 'mcp_tool_call_output':
      addCodeCandidate(sections, 'Tool result', own(item, 'output'), 'json');
      break;
    default:
      break;
  }
  return sections;
}

function roleLabel(value: unknown, fallback: string): string {
  const role = valueLabel(value)?.toLowerCase();
  if (!role) return fallback;
  if (role === 'gpt' || role === 'model' || role === 'bot') return 'assistant';
  if (role === 'human') return 'user';
  return role;
}

function genericDatasetSections(payload: EventObject): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  const addMessageGroup = (label: string, messages: unknown[]): void => {
    messages.slice(0, 32).forEach((rawMessage, index) => {
      const message = objectOf(rawMessage);
      const role = roleLabel(message?.role ?? message?.from ?? message?.speaker, `message ${index + 1}`);
      const content = message
        ? (own(message, 'content') ?? own(message, 'text') ?? own(message, 'value'))
        : rawMessage;
      const text = textSection(content);
      if (text.text === undefined) return;
      const title = `${label} ${index + 1} · ${role}`;
      const richText = role === 'assistant' || role === 'function' || role === 'tool';
      sections.push({ title, ...text, richText });
    });
  };
  if (Array.isArray(payload.messages)) addMessageGroup('Message', payload.messages);
  if (Array.isArray(payload.conversations)) addMessageGroup('Conversation', payload.conversations);
  if (Array.isArray(payload.chosen_messages)) addMessageGroup('Chosen', payload.chosen_messages);
  if (Array.isArray(payload.rejected_messages)) addMessageGroup('Rejected', payload.rejected_messages);

  // Alpaca and ranking datasets use named columns instead of a messages array.
  addTextCandidate(sections, 'System', own(payload, 'system'));
  addTextCandidate(sections, 'Prompt', own(payload, 'instruction'));
  addTextCandidate(sections, 'Input', own(payload, 'input'));
  addTextCandidate(sections, 'Response', own(payload, 'output'), true);
  addTextCandidate(sections, 'History', own(payload, 'history'));
  addTextCandidate(sections, 'Chosen', own(payload, 'chosen'), true);
  addTextCandidate(sections, 'Rejected', own(payload, 'rejected'), true);
  if (own(payload, 'tools') !== undefined) addCodeCandidate(sections, 'Tools', own(payload, 'tools'), 'json');
  return sections;
}

function genericDatasetKind(
  payload: EventObject,
  genericTextKey: string | undefined,
): string | undefined {
  if (Array.isArray(payload.messages)) return 'messages';
  if (Array.isArray(payload.conversations)) return 'conversations';
  if (Array.isArray(payload.chosen_messages) || Array.isArray(payload.rejected_messages)) return 'preference';
  if (genericTextKey) return genericTextKey;
  if (textOf(own(payload, 'instruction')) !== undefined) return 'instruction';
  if (textOf(own(payload, 'output')) !== undefined) return 'output';
  if (textOf(own(payload, 'chosen')) !== undefined && textOf(own(payload, 'rejected')) !== undefined) return 'preference';
  return undefined;
}

export function buildAgentEventPresentation(
  value: unknown,
  profile?: AgentRowProjection,
): AgentEventPresentationModel | undefined {
  const envelope = objectOf(value);
  if (!envelope || !isEventEnvelope(envelope, profile)) return undefined;
  const payload = objectOf(envelope.payload) ?? envelope;
  const completedItem = objectOf(payload.item);
  const envelopeType = valueLabel(envelope.type);
  const payloadType = valueLabel(payload.type);
  const semanticType = envelopeType === 'event_msg' ? payloadType : envelopeType;
  const genericTextKey = profile?.profileId === 'generic'
    ? ['text', 'content', 'message'].find((key) => textOf(own(payload, key)) !== undefined)
    : undefined;
  const genericDatasetKey = profile?.profileId === 'generic'
    ? genericDatasetKind(payload, genericTextKey)
    : undefined;
  const itemType = firstString(completedItem ? [completedItem, payload] : [payload], ['type', 'event_type', 'kind', 'item_type']);
  const lifecycleType = payloadType?.startsWith('item.')
    ? payloadType.replace('.', '_')
    : (envelopeType?.startsWith('item.') ? envelopeType.replace('.', '_') : payloadType);
  const lifecycle = lifecycleType === 'item_started' || lifecycleType === 'item_updated' || lifecycleType === 'item_completed'
    ? lifecycleType
    : undefined;
  const isCodexProfile = profile?.profileId === 'codex-rollout' || profile?.profileId === 'codex-exec-jsonl';
  const topLevelCodexItem = isCodexProfile && !completedItem && normalizeCodexItemType(typeof payload.type === 'string' ? payload.type : undefined)
    ? payload
    : undefined;
  const codexItemSource = completedItem ?? topLevelCodexItem;
  const codexItem = isCodexProfile
    ? classifyCodexItem(codexItemSource, lifecycle)
    : undefined;
  const normalizedItemType = codexItem?.normalizedType
    ?? normalizeCodexItemType(typeof codexItemSource?.type === 'string' ? codexItemSource.type : undefined);
  const kind = genericDatasetKey ?? itemType ?? envelopeType ?? profile?.eventKind ?? 'event';
  const customToolName = normalizedItemType === 'custom_tool_call' ? valueLabel(own(codexItemSource ?? payload, 'name')) : undefined;
  const displayKind = customToolName === 'exec'
    ? 'Code Mode · exec'
    : customToolName === 'js_repl'
      ? 'JavaScript · js_repl'
      : normalizedItemType === 'extension' && typeof own(codexItemSource ?? payload, 'kind') === 'string'
      ? `Extension · ${String(own(codexItemSource ?? payload, 'kind'))}`
      : kind.replaceAll('_', ' ');
  const title = `${presentationProduct(profile)} · ${displayKind}`;
  const metadata: Array<{ label: string; value: string }> = [];
  const addMetadata = (label: string, value: string | undefined): void => {
    if (value && metadata.length < MAX_METADATA && !metadata.some((item) => item.label === label)) {
      metadata.push({ label, value });
    }
  };
  const sources = completedItem ? [completedItem, payload, envelope] : [payload, envelope];
  addMetadata('role', profile?.actor ?? firstString(sources, ['role', 'actor']));
  addMetadata('status', profile?.status ?? firstString(sources, ['status', 'state', 'kind']));
  addMetadata('session', profile?.sessionId ?? firstString(sources, ['session_id', 'sessionId']));
  addMetadata('turn', profile?.turnId ?? firstString(sources, ['turn_id', 'turnId']));
  addMetadata('thread', firstString(sources, ['thread_id', 'threadId', 'agent_thread_id']));
  addMetadata('model', profile?.model ?? firstString(sources, ['model', 'model_provider']));
  addMetadata('tool', firstString(sources, ['name', 'tool_name', 'tool', 'server']));
  addMetadata('severity', profile?.severity ?? firstString(sources, ['severity', 'level']));
  addMetadata('project', firstString(sources, ['project']));
  const claudeMessage = profile?.profileId === 'claude-code-session' ? objectOf(payload.message) : undefined;
  const claudeBlocks = Array.isArray(claudeMessage?.content) ? claudeMessage.content : [];
  const claudeBlock = objectOf(claudeBlocks[0]);
  if (claudeMessage) {
    addMetadata('message role', valueLabel(claudeMessage.role));
    addMetadata('tool use id', valueLabel(claudeBlock?.tool_use_id));
    if (typeof claudeBlock?.is_error === 'boolean') addMetadata('error', String(claudeBlock.is_error));
  }
  if (itemType === 'custom_tool_call' || itemType === 'custom_tool_call_output') {
    addMetadata('wire type', itemType);
    if (itemType === 'custom_tool_call') {
      addMetadata('input format', customToolName === 'exec' || customToolName === 'js_repl' ? 'freeform/javascript' : 'freeform');
    }
    addMetadata('call id', profile?.toolCallId ?? firstString(sources, ['call_id']));
  }
  if (normalizedItemType === 'extension') addMetadata('extension', valueLabel(own(codexItemSource ?? payload, 'kind')));
  if (semanticType === 'world_state' && typeof own(payload, 'full') === 'boolean') {
    addMetadata('snapshot', payload.full === true ? 'full' : 'partial');
  }

  const sections: EventPresentationSection[] = [];
  const timeline = isClaudeJobTimelineRecord(payload);
  const timelineText = timeline
    ? (typeof payload.text === 'string' && payload.text.length > 0 ? payload.text : payload.detail)
    : undefined;
  const historyText = isClaudeHistoryRecord(payload) ? payload.display : undefined;
  const plainText = typeof payload.text === 'string' ? payload.text : undefined;
  const itemContent = codexItemSource?.content
    ?? (normalizedItemType === 'agent_message' ? codexItemSource?.text : undefined)
    ?? (normalizedItemType === 'plan' ? codexItemSource?.text : undefined);
  const content = itemContent
    ?? payload.content
    ?? payload.message
    ?? timelineText
    ?? historyText
    ?? plainText
    ?? payload.lastPrompt
    ?? payload.prompt;
  const claudeSections = claudeMessageSections(payload, profile);
  const messageText = claudeSections.length > 0 ? {} : textSection(content);
  const lowerKind = kind.toLowerCase();
  const isPrompt = lowerKind === 'last-prompt' || lowerKind === 'prompt';
  const isObservation = profile?.eventKind === 'observation' || lowerKind === 'observation';
  if (claudeSections.length > 0) {
    sections.push(...claudeSections);
  } else if (messageText.text && (
    profile?.eventKind === 'message'
    || lowerKind.includes('message')
    || lowerKind === 'reasoning'
    || lowerKind === 'user_message'
    || lowerKind === 'assistant_message'
    || isPrompt
    || isObservation
    || genericTextKey !== undefined
  )) {
    sections.push({
      title: genericTextKey
        ? genericTextKey[0]?.toUpperCase() + genericTextKey.slice(1)
        : (isPrompt ? 'Prompt' : (lowerKind.includes('reason') ? 'Reasoning' : (isObservation ? 'Detail' : 'Message'))),
      ...messageText,
      richText: isAgentMarkdownText(codexItemSource, payload, content, profile)
        || isAgentMarkdownText(payload, payload, content, profile),
    });
  }
  if (profile?.profileId === 'generic') sections.push(...genericDatasetSections(payload));
  if (isCodexProfile) {
    if (profile?.profileId === 'codex-rollout') sections.push(...codexContextSections(semanticType, payload));
    sections.push(...codexItemSections(codexItemSource, normalizedItemType));
    if (normalizedItemType && ['custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output', 'mcp_tool_call_output'].includes(normalizedItemType)) {
      sections.push(...codexResponseItemSections(normalizedItemType, codexItemSource ?? payload));
    }
  }
  const toolInput = completedItem?.arguments
    ?? completedItem?.input
    ?? completedItem?.command
    ?? payload.arguments
    ?? payload.input
    ?? payload.command;
  if (toolInput !== undefined
    && (lowerKind.includes('call') || lowerKind.includes('tool') || payload.command !== undefined)
    && normalizedItemType !== 'custom_tool_call'
    && !sections.some((section) => section.title === 'Command' || section.title === 'Arguments' || section.title === 'Tool call')) {
    addCodeCandidate(sections, 'Tool call', toolInput);
  }
  const toolOutput = completedItem?.output
    ?? completedItem?.result
    ?? completedItem?.aggregated_output
    ?? payload.output
    ?? payload.result;
  if (toolOutput !== undefined
    && (lowerKind.includes('output') || lowerKind.includes('result') || lowerKind.includes('tool'))
    && normalizedItemType !== 'custom_tool_call_output'
    && normalizedItemType !== 'function_call_output'
    && !sections.some((section) => section.title === 'Result' || section.title === 'Output' || section.title === 'Tool result' || section.title === 'aggregated output')) {
    const outputText = textSection(toolOutput);
    if (outputText.text !== undefined) sections.push({ title: 'Tool result', ...outputText });
    else addCodeCandidate(sections, 'Tool result', toolOutput);
  }
  if (lowerKind.includes('event') && !sections.length) {
    const eventText = textSection(payload.message ?? payload.output ?? payload.reason ?? payload);
    if (eventText.text !== undefined) sections.push({ title: 'Event', ...eventText });
  }
  if (!sections.length) {
    const payloadTitle = semanticType === 'session_meta' || semanticType === 'turn_context' ? 'Context' : 'Payload';
    if (payloadTitle === 'Context') {
      const payloadCode = contextCode(payload);
      if (payloadCode !== undefined) sections.push({ title: payloadTitle, code: payloadCode });
    } else addCodeCandidate(sections, payloadTitle, payload);
  }
  return { title, kind, metadata, sections };
}

interface AgentEventPresentationProps {
  value: unknown;
  profile?: AgentRowProjection | undefined;
}

export function AgentEventPresentation({ value, profile }: AgentEventPresentationProps): React.JSX.Element | null {
  const model = useMemo(() => buildAgentEventPresentation(value, profile), [profile, value]);
  const [expandedSections, setExpandedSections] = React.useState<ReadonlySet<number>>(() => new Set());
  if (!model) return null;
  return (
    <section className="event-presentation" aria-label="Structured event view">
      <header className="event-presentation-header">
        <div>
          <div className="event-presentation-title">{model.title}</div>
          <div className="event-presentation-kind">{model.kind.replaceAll('_', ' ')}</div>
        </div>
        <span className="event-kind-badge">{profile?.eventKind ?? 'event'}</span>
      </header>
      {model.metadata.length ? (
        <dl className="event-fields">
          {model.metadata.map((item) => <React.Fragment key={item.label}><dt>{item.label}</dt><dd title={item.value}>{item.value}</dd></React.Fragment>)}
        </dl>
      ) : null}
      <div className="event-sections">
        {model.sections.map((section, index) => (
          <section className="event-section" key={`${section.title}:${index}`}>
            <div className="event-section-header">
              <h3>{section.title}</h3>
              <CopyButton
                text={section.copyText ?? section.fullText ?? section.text ?? section.code ?? ''}
                label={`Copy ${section.title}${section.previewOnly ? ' preview' : ''}`}
              />
            </div>
            {section.truncated && section.fullText !== undefined ? (
              <button
                type="button"
                className="event-section-action"
                onClick={() => setExpandedSections((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })}
              >
                {expandedSections.has(index) ? 'Show preview' : 'Show full'}
              </button>
            ) : null}
            {section.previewOnly ? <div className="content-budget-notice" role="status">Preview limited by the record hydration budget; the complete value remains available in the Raw view when the source is complete.</div> : null}
            {section.text !== undefined ? (
              <ContentView
                key={`content:${section.fullText ?? section.text ?? String(index)}`}
                text={expandedSections.has(index) ? section.fullText ?? section.text : section.text}
                truncated={section.truncated === true && !expandedSections.has(index)}
                ariaLabel={`${section.title} content`}
                defaultMode={section.contentMode ?? (section.richText ? 'markdown' : 'auto')}
                {...(section.codeLanguage ? { codeLanguage: section.codeLanguage } : {})}
              />
            ) : null}
            {section.code !== undefined ? (
              section.language === 'diff'
                ? <DiffView
                    key={`diff-code:${section.code}`}
                    source={expandedSections.has(index) ? section.fullText ?? section.code : section.code}
                    ariaLabel={`${section.title} unified diff`}
                  />
                : section.language === 'json'
                ? <ContentView
                    key={`json-code:${section.code}`}
                    text={expandedSections.has(index) ? section.fullText ?? section.code : section.code}
                    truncated={section.truncated === true && !expandedSections.has(index)}
                    ariaLabel={`${section.title} JSON`}
                    defaultMode="json"
                  />
                : section.language
                ? <div className="event-code-language"><HighlightedCode key={`code:${section.code}`} source={expandedSections.has(index) ? section.fullText ?? section.code : section.code} language={section.language} ariaLabel={`${section.title} code`} {...(section.codeWrap ? { className: 'is-wrapped' } : {})} /></div>
                : <ContentView key={`code:${section.code}`} text={expandedSections.has(index) ? section.fullText ?? section.code : section.code} truncated={section.truncated === true && !expandedSections.has(index)} ariaLabel={`${section.title} code`} />
            ) : null}
          </section>
        ))}
      </div>
    </section>
  );
}
