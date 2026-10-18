import type { AgentRowProjection } from '../shared/types';
import { isObject, numberAt, objectAt, own, stringAt } from './utils';

// Persisted agent-core-v2 wire records, not the similarly named transport protocol.
export const KIMI_SOURCE_REVISION = 'ef727e517923cb312cb48d42825c49dfacd528e7';
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MAX_PARTS = 16;
const TEXT_BUDGET = 240;
const MAX_TOOL_SNAPSHOT_ITEMS = 32;

export function isKimiMetadata(value: unknown): boolean {
  const version = stringAt(value, 'protocol_version');
  return stringAt(value, 'type') === 'metadata'
    && version !== undefined && /^1\.\d{1,3}$/.test(version)
    && kimiTimestamp(numberAt(value, 'created_at')) !== undefined;
}

export function isKimiContextRecord(value: unknown): boolean {
  switch (stringAt(value, 'type')) {
    case 'llm.tools_snapshot':
      return isKimiToolsSnapshot(value);
    case 'task.started':
      return stringAt(objectAt(value, 'info'), 'description') !== undefined
        || stringAt(value, 'description') !== undefined;
    case 'prompt.steered':
      return isObject(value) && Array.isArray(own(value, 'content'));
    case 'config.update':
    case 'profile.bind':
      return isObject(value) && typeof own(value, 'systemPrompt') === 'string';
    case 'context.append_message': {
      const message = objectAt(value, 'message');
      return message !== undefined && MESSAGE_ROLES.has(stringAt(message, 'role') ?? '')
        && Array.isArray(own(message, 'content')) && Array.isArray(own(message, 'toolCalls'));
    }
    case 'context.append_loop_event': {
      const event = objectAt(value, 'event');
      if (!event) return false;
      switch (stringAt(event, 'type')) {
        case 'step.begin':
        case 'step.end':
          return stringAt(event, 'uuid') !== undefined;
        case 'content.part':
          return stringAt(event, 'stepUuid') !== undefined
            && stringAt(event, 'part', 'type') !== undefined;
        case 'tool.call':
          return stringAt(event, 'stepUuid') !== undefined
            && stringAt(event, 'toolCallId') !== undefined
            && (stringAt(event, 'name') !== undefined
              || own(event, 'command') !== undefined
              || stringAt(event, 'display', 'command') !== undefined
              || stringAt(event, 'args', 'command') !== undefined);
        case 'tool.result': {
          const output = objectAt(event, 'result')?.output;
          return stringAt(event, 'toolCallId') !== undefined
            && (typeof output === 'string' || Array.isArray(output));
        }
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

/** Kimi's durable tool snapshot schema, bounded at the inspection edge. */
export function isKimiToolsSnapshot(value: unknown): boolean {
  if (!isObject(value) || stringAt(value, 'type') !== 'llm.tools_snapshot'
    || stringAt(value, 'agentId') === undefined || stringAt(value, 'hash') === undefined) return false;
  const tools = own(value, 'tools');
  if (!Array.isArray(tools)) return false;
  for (let index = 0; index < Math.min(tools.length, MAX_TOOL_SNAPSHOT_ITEMS); index += 1) {
    const tool = tools[index];
    if (!isObject(tool) || stringAt(tool, 'name') === undefined || stringAt(tool, 'description') === undefined
      || !isObject(own(tool, 'parameters'))) return false;
  }
  return true;
}

export function kimiToolSnapshotCount(value: unknown): number | undefined {
  const tools = isObject(value) ? own(value, 'tools') : undefined;
  return isKimiToolsSnapshot(value) && Array.isArray(tools) ? tools.length : undefined;
}

/** Numeric wire timestamps are epoch milliseconds. No unit guessing or path IO. */
export function kimiTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Bounded preview only; encrypted/hidden thinking and media payloads stay opaque. */
export function kimiContentPreview(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, TEXT_BUDGET);
  if (!Array.isArray(value)) return '';
  let text = '';
  for (let index = 0; index < Math.min(value.length, MAX_PARTS) && text.length < TEXT_BUDGET; index++) {
    const part = value[index];
    const type = stringAt(part, 'type');
    let fragment: string | undefined;
    if (type === 'text') fragment = stringAt(part, 'text');
    else if (type === 'think') {
      fragment = isObject(part) && (own(part, 'hidden') === true || own(part, 'encrypted') !== undefined)
        ? '[hidden reasoning]' : stringAt(part, 'think');
    } else if (type === 'image_url' || type === 'audio_url' || type === 'video_url') {
      fragment = `[${type.slice(0, -4)} reference]`;
    } else if (type) fragment = `[${type.slice(0, 48)}]`;
    if (fragment) text += `${text ? ' ' : ''}${fragment.slice(0, TEXT_BUDGET - text.length)}`;
  }
  return text.slice(0, TEXT_BUDGET);
}

/** Kimi splits input tokens into uncached, cache-read and cache-creation buckets. */
export function kimiUsage(value: unknown): AgentRowProjection['usage'] | undefined {
  if (!isObject(value)) return undefined;
  const inputOther = tokenCount(value, 'inputOther');
  const cached = tokenCount(value, 'inputCacheRead');
  const created = tokenCount(value, 'inputCacheCreation');
  const output = tokenCount(value, 'output');
  const sum = inputOther !== undefined && cached !== undefined && created !== undefined
    ? inputOther + cached + created : undefined;
  const input = sum !== undefined && Number.isSafeInteger(sum) ? sum : undefined;
  const total = input !== undefined && output !== undefined && Number.isSafeInteger(input + output)
    ? input + output : undefined;
  if (input === undefined && output === undefined && cached === undefined) return undefined;
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
    ...(cached !== undefined ? { cached } : {}), ...(total !== undefined ? { total } : {}) };
}

function tokenCount(value: Record<string, unknown>, key: string): number | undefined {
  const count = own(value, key);
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}
