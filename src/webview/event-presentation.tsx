import type React from 'react';
import type { AgentRowProjection } from '../shared/types';
import {
  isClaudeHistoryRecord,
  isClaudeJobTimelineRecord,
} from '../profiles/claude-record-strategy';
import {
  classifyCodexItem,
  normalizeCodexItemType,
} from '../profiles/codex-item-strategy';
import { stringifyJsonBounded } from './json-syntax';
import { classifyContent, inferCodeLanguage } from './content-view';
import { formatJavaScriptForDisplay } from './code-syntax';
import { DEFAULT_MAX_CHARS } from './code-syntax-core';
import { buildClaudeEventSections, type ClaudeEventBuilderContext } from './providers/claude-event-builder';
import {
  buildCodexContextSections,
  buildCodexItemSections,
  buildCodexResponseItemSections,
  type CodexEventBuilderContext,
} from './providers/codex-event-builder';
import { buildPiEventSections, type PiEventBuilderContext } from './providers/pi-event-builder';
import type { AgentEventPresentationModel, EventPresentationSection, FunctionCallView } from './features/event-presentation/model';
import { AgentEventPresentation as AgentEventPresentationView, type AgentEventPresentationProps } from './features/event-presentation/AgentEventPresentation';
export type { AgentEventPresentationProps } from './features/event-presentation/AgentEventPresentation';

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

interface CodeSectionValue {
  code: string;
  fullCode?: string;
  truncated: boolean;
  previewOnly: boolean;
  mode?: 'code' | 'patch';
}

export type { AgentEventPresentationModel, EventPresentationSection, FunctionCallView };

export function AgentEventPresentation(props: Omit<AgentEventPresentationProps, 'buildModel'>): React.JSX.Element | null {
  return <AgentEventPresentationView {...props} buildModel={buildAgentEventPresentation} />;
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
  const result = stringifyJsonBounded(value, {
    maxChars: MAX_TEXT,
    maxNodes: 500,
    maxDepth: 10,
    maxChildren: 80,
    maxStringChars: 2_048,
  });
  const expanded = result.truncated
    ? stringifyJsonBounded(value, {
      maxChars: MAX_EXPANDED_STRUCTURED_TEXT,
      maxNodes: 10_000,
      maxDepth: 32,
      maxChildren: MAX_TEXT_ITEMS,
      maxStringChars: MAX_EXPANDED_STRUCTURED_TEXT,
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
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function presentationProduct(profile?: AgentRowProjection): string {
  if (profile?.profileId === 'codex-rollout' || profile?.profileId === 'codex-exec-jsonl' || profile?.profileId === 'codex-trace') return 'Codex';
  if (profile?.profileId === 'claude-code-session') return 'Claude';
  if (profile?.profileId === 'pi-coding-agent') return 'Pi';
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
  copyText?: string,
): void {
  if (value === undefined || sections.some((section) => section.title === title)) return;
  const rendered = codeSectionValue(value);
  if (rendered !== undefined) {
    sections.push({
      title,
      code: rendered.code,
      ...(rendered.fullCode === undefined ? {} : { fullText: rendered.fullCode }),
      ...(copyText === undefined ? {} : { copyText }),
      truncated: rendered.truncated,
      previewOnly: rendered.previewOnly,
      ...(language ? { language } : {}),
    });
  }
}

function decodeSerializedJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const original = value;
  let current: unknown = value;

  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'string') return current;
    if (current.length > DEFAULT_MAX_CHARS) return original;
    const trimmed = current.trim();
    if (!trimmed || !(trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"'))) return original;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') return parsed;
      if (typeof parsed === 'string' && parsed !== current) {
        current = parsed;
        continue;
      }
    } catch {
      return original;
    }
    return original;
  }

  return original;
}

function addExecCommandView(
  section: EventPresentationSection,
  name: string | undefined,
  argumentsValue: unknown,
): void {
  if (name !== 'exec_command') return;
  const argumentsObject = objectOf(argumentsValue);
  if (!argumentsObject || typeof argumentsObject.cmd !== 'string') return;
  const command = codeSectionValue(argumentsObject.cmd);
  if (!command) return;
  if (/^\s*apply_patch(?:\s|$)[\s\S]*(?:^|\r?\n)\*\*\* Begin Patch\r?$/m.test(argumentsObject.cmd)) {
    command.mode = 'patch';
  }

  const options: EventObject = {};
  for (const key in argumentsObject) {
    if (Object.hasOwn(argumentsObject, key) && key !== 'cmd') options[key] = argumentsObject[key];
  }
  const optionsValue = Object.keys(options).length > 0 ? codeSectionValue(options) : undefined;

  section.code = command.code;
  if (command.fullCode === undefined) delete section.fullText;
  else section.fullText = command.fullCode;
  section.truncated = command.truncated;
  section.previewOnly = command.previewOnly;
  section.language = 'shell';
  section.codeWrap = true;
  section.functionCall = {
    name,
    command,
    ...(optionsValue ? { options: optionsValue } : {}),
  };
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
  return diff ? addTextDiffCandidate(sections, title, diff.source, diff.truncated) : false;
}

/**
 * Present an agent-owned textual diff through the same bounded DiffView path
 * used by Codex FileChange records. The source remains authoritative in Raw;
 * this helper only creates a preview and never interprets patch operations.
 */
function addTextDiffCandidate(
  sections: EventPresentationSection[],
  title: string,
  value: unknown,
  alreadyTruncated = false,
): boolean {
  if (typeof value !== 'string' || value.length === 0 || sections.some((section) => section.title === title)) return false;
  const expanded = value.slice(0, MAX_EXPANDED_STRUCTURED_TEXT);
  const source = expanded.length > MAX_TEXT
    ? expanded.slice(0, MAX_TEXT) + '\n... [preview truncated]'
    : expanded;
  const sourceTruncated = alreadyTruncated || expanded.length < value.length;
  const hasFullSource = !sourceTruncated;
  sections.push({
    title,
    code: source,
    ...(hasFullSource ? { fullText: expanded } : {}),
    truncated: sourceTruncated || expanded.length > MAX_TEXT,
    previewOnly: !hasFullSource,
    language: 'diff',
  });
  return true;
}

function appendAgentContentBlock(
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
        appendAgentContentBlock(sections, result[index], `${title} · ${String(index + 1)}`, role);
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

  if (type === 'toolcall' || type === 'tool_call') {
    const name = valueLabel(own(object, 'name'));
    const argumentsValue = own(object, 'arguments') ?? own(object, 'input');
    addCodeCandidate(sections, name ? ('Tool call · ' + name) : title, argumentsValue ?? object, 'json');
    return;
  }

  if (type === 'image') {
    addCodeCandidate(sections, title, object, 'json');
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

/** Provider-only Codex projection; the builder owns provider-specific field semantics. */
function codexContextSections(envelopeType: string | undefined, payload: EventObject): EventPresentationSection[] {
  return buildCodexContextSections(envelopeType, payload, codexEventBuilderContext);
}

function codexItemSections(item: EventObject | undefined, normalizedType: string | undefined): EventPresentationSection[] {
  return buildCodexItemSections(item, normalizedType, codexEventBuilderContext);
}

function codexResponseItemSections(itemType: string | undefined, item: EventObject): EventPresentationSection[] {
  return buildCodexResponseItemSections(itemType, item, codexEventBuilderContext);
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

const claudeEventBuilderContext: ClaudeEventBuilderContext = {
  objectOf,
  own,
  valueLabel,
  textOf,
  textSection,
  codeSectionValue: (value) => {
    const rendered = codeSectionValue(value);
    if (!rendered) return undefined;
    return {
      code: rendered.code,
      ...(rendered.fullCode !== undefined ? { fullCode: rendered.fullCode } : {}),
      truncated: rendered.truncated,
      previewOnly: rendered.previewOnly,
    };
  },
  addTextCandidate,
  addCodeCandidate,
  addTextDiffCandidate,
  appendAgentContentBlock,
};

const codexEventBuilderContext: CodexEventBuilderContext = {
  own,
  valueAtPath,
  valueLabel,
  addTextCandidate,
  addOutputCandidate,
  addCodeCandidate,
  addDiffCandidate,
  addCommandCandidate,
  addCommandOutputCandidate,
  addJavaScriptCandidate,
  decodeSerializedJsonValue,
  addExecCommandView,
};

const piEventBuilderContext: PiEventBuilderContext = {
  objectOf,
  own,
  valueLabel,
  addTextCandidate,
  addOutputCandidate,
  addCodeCandidate,
  addTextDiffCandidate,
  addDiffCandidate,
  appendAgentContentBlock,
};

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
  const claudeSections = buildClaudeEventSections(payload, profile, claudeEventBuilderContext);
  const piSections = buildPiEventSections(payload, profile, piEventBuilderContext);
  const specializedSections = claudeSections.length > 0 ? claudeSections : piSections;
  const messageText = specializedSections.length > 0 ? {} : textSection(content);
  const lowerKind = kind.toLowerCase();
  const isPrompt = lowerKind === 'last-prompt' || lowerKind === 'prompt';
  const isObservation = profile?.eventKind === 'observation' || lowerKind === 'observation';
  if (specializedSections.length > 0) {
    sections.push(...specializedSections);
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
