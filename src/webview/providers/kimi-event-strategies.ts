import type { EventPresentationSection } from '../features/event-presentation/model';
import type { AgentRowProjection } from '../../shared/types';
import type { KimiEventBuilderContext, KimiEventObject } from './kimi-event-builder';

const MAX_ITEMS = 32;
const MAX_RENDERED_SECTIONS = 96;
const MAX_RENDERED_TEXT_BYTES = 128 * 1024;

export type KimiCandidate =
  | { kind: 'text'; title: string; value: unknown; richText?: boolean }
  | { kind: 'code'; title: string; value: unknown; language?: string }
  | { kind: 'truncated'; title: string; omitted: number };

export interface KimiEventStrategy {
  readonly id: string;
  readonly eventTypes: readonly string[];
  matches(profile: AgentRowProjection | undefined): boolean;
  present(
    payload: KimiEventObject,
    profile: AgentRowProjection | undefined,
    context: KimiEventBuilderContext,
  ): EventPresentationSection[];
}

const own = (object: KimiEventObject, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined;
const objectOf = (value: unknown): KimiEventObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as KimiEventObject : undefined;
const label = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const text = (title: string, value: unknown, richText = false): KimiCandidate => ({ kind: 'text', title, value, ...(richText ? { richText } : {}) });
const code = (title: string, value: unknown, language = 'json'): KimiCandidate => ({ kind: 'code', title, value, language });
const omitted = (title: string, count: number): KimiCandidate => ({ kind: 'truncated', title, omitted: count });

function part(value: unknown, title: string, role?: string): KimiCandidate[] {
  const item = objectOf(value);
  if (!item) return [text(title, value, role === 'assistant')];
  switch (own(item, 'type')) {
    case 'text': return [text(title, own(item, 'text'), role === 'assistant')];
    case 'think':
      return own(item, 'hidden') === true || own(item, 'encrypted') !== undefined
        ? [code('Opaque reasoning · source flag', { type: 'think', opaque: true })]
        : [text('Reasoning', own(item, 'think'))];
    case 'image_url':
    case 'audio_url':
    case 'video_url': return [code(title + ' · reference or structured content', item)];
    default: return [code(title + ' · reference or structured content', item)];
  }
}

function content(value: unknown, title: string, role?: string): KimiCandidate[] {
  if (!Array.isArray(value)) return part(value, title, role);
  const count = Math.min(value.length, MAX_ITEMS);
  const result: KimiCandidate[] = [];
  for (let index = 0; index < count; index += 1) result.push(...part(value[index], title + ' ' + (index + 1), role));
  if (count < value.length) result.push(omitted('Additional content · available in Raw', value.length - count));
  return result;
}

function toolSchemas(value: unknown, prefix: string, schemaKeys: readonly string[]): KimiCandidate[] {
  if (!Array.isArray(value)) return [];
  const count = Math.min(value.length, MAX_ITEMS);
  const result: KimiCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = objectOf(value[index]);
    if (!item) {
      result.push(code(prefix + ' ' + (index + 1) + ' · structured content', value[index]));
      continue;
    }
    const name = label(own(item, 'name')) ?? String(index + 1);
    if (own(item, 'description') !== undefined) result.push(text(prefix + ' description · ' + name, own(item, 'description')));
    for (const key of schemaKeys) {
      const schema = own(item, key);
      if (schema !== undefined) {
        result.push(code(prefix + ' parameters · ' + name, schema));
        break;
      }
    }
  }
  if (count < value.length) result.push(omitted('Additional ' + prefix.toLowerCase() + 's · available in Raw', value.length - count));
  return result;
}

function toolCall(event: KimiEventObject): KimiCandidate[] {
  const name = label(own(event, 'name'));
  const title = name ? 'Tool call · ' + name : 'Tool call';
  const result: KimiCandidate[] = [];
  const args = own(event, 'args');
  const argsObject = argumentObject(args);
  const display = objectOf(own(event, 'display'));
  const directCommand = own(event, 'command');
  const displayCommand = display ? own(display, 'command') : undefined;
  const argsCommand = argsObject ? own(argsObject, 'command') : undefined;
  // Legacy wires may persist a direct command. When present it is the record's
  // explicit value; current Kimi wires use display.command before args.command.
  if (directCommand !== undefined) result.push(code(name ? 'Tool command · ' + name : 'Tool command', directCommand, 'shell'));
  else if (displayCommand !== undefined) result.push(code(name ? 'Tool command · ' + name : 'Tool command', displayCommand, 'shell'));
  else if (argsCommand !== undefined) result.push(code(title, argsCommand, 'shell'));
  else if (args !== undefined) result.push(code(title, args));
  if (display && own(display, 'description') !== undefined) result.push(text(name ? 'Tool description · ' + name : 'Tool description', own(display, 'description')));
  if (own(event, 'extras') !== undefined) result.push(code(title + ' extras', own(event, 'extras')));
  return result;
}

function argumentObject(value: unknown): KimiEventObject | undefined {
  const direct = objectOf(value);
  if (direct) return direct;
  if (typeof value !== 'string' || value.length > MAX_RENDERED_TEXT_BYTES) return undefined;
  try {
    return objectOf(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function toolResult(event: KimiEventObject): KimiCandidate[] {
  const result = objectOf(own(event, 'result'));
  const output = result ? own(result, 'output') : own(event, 'output');
  const candidates = output === undefined ? [] : content(output, 'Tool result', 'tool');
  if (!result) return candidates;
  if (own(result, 'note') !== undefined) candidates.push(text('Result note', own(result, 'note')));
  return candidates;
}

abstract class KimiStrategyBase implements KimiEventStrategy {
  abstract readonly id: string;
  abstract readonly eventTypes: readonly string[];
  abstract collect(payload: KimiEventObject): readonly KimiCandidate[];

  matches(profile: AgentRowProjection | undefined): boolean {
    return profile?.profileId === 'kimi-code-session';
  }

  present(
    payload: KimiEventObject,
    _profile: AgentRowProjection | undefined,
    context: KimiEventBuilderContext,
  ): EventPresentationSection[] {
    return renderKimiCandidates(this.collect(payload), context);
  }
}

function taskInfoCandidates(info: KimiEventObject): KimiCandidate[] {
  const result: KimiCandidate[] = [];
  if (own(info, 'kind') !== undefined) result.push(text('Task kind', own(info, 'kind')));
  if (own(info, 'description') !== undefined) result.push(text('Task description', own(info, 'description')));
  if (own(info, 'status') !== undefined) result.push(text('Task status', own(info, 'status')));
  if (own(info, 'stopReason') !== undefined) result.push(text('Task stop reason', own(info, 'stopReason')));
  if (own(info, 'timeoutMs') !== undefined) result.push(text('Task timeout', own(info, 'timeoutMs')));
  if (own(info, 'kind') === undefined && own(info, 'command') !== undefined) {
    result.push(code('Task command', own(info, 'command'), 'shell'));
  }
  switch (own(info, 'kind')) {
    case 'process':
      if (own(info, 'command') !== undefined) result.push(code('Task command', own(info, 'command'), 'shell'));
      if (own(info, 'pid') !== undefined) result.push(text('Task pid', own(info, 'pid')));
      if (own(info, 'exitCode') !== undefined) result.push(text('Task exit code', own(info, 'exitCode')));
      break;
    case 'agent':
      if (own(info, 'agentId') !== undefined) result.push(text('Task agent', own(info, 'agentId')));
      if (own(info, 'subagentType') !== undefined) result.push(text('Subagent type', own(info, 'subagentType')));
      if (own(info, 'model') !== undefined) result.push(text('Task model', own(info, 'model')));
      if (own(info, 'thinkingEffort') !== undefined) result.push(text('Thinking effort', own(info, 'thinkingEffort')));
      if (own(info, 'stopCode') !== undefined) result.push(text('Task stop code', own(info, 'stopCode')));
      break;
    case 'question':
      if (own(info, 'questionCount') !== undefined) result.push(text('Question count', own(info, 'questionCount')));
      if (own(info, 'toolCallId') !== undefined) result.push(text('Question tool call', own(info, 'toolCallId')));
      break;
    default:
      break;
  }
  return result;
}

class LoopStrategy extends KimiStrategyBase {
  readonly id = 'loop';
  readonly eventTypes = ['context.append_loop_event'] as const;
  collect(payload: KimiEventObject): readonly KimiCandidate[] {
    const event = objectOf(own(payload, 'event'));
    if (!event) return [];
    switch (own(event, 'type')) {
      case 'content.part': return part(own(event, 'part'), 'Content', 'assistant');
      case 'tool.call': return toolCall(event);
      case 'tool.result': return toolResult(event);
      default: return [];
    }
  }
}

class ContentStrategy extends KimiStrategyBase {
  readonly id = 'content';
  readonly eventTypes = ['context.append_message', 'prompt.steered', 'turn.prompt', 'turn.steer'] as const;
  collect(payload: KimiEventObject): readonly KimiCandidate[] {
    switch (own(payload, 'type')) {
      case 'context.append_message': {
        const message = objectOf(own(payload, 'message'));
        if (!message) return [];
        const result = content(own(message, 'content'), 'Message', label(own(message, 'role')));
        const calls = own(message, 'toolCalls');
        if (Array.isArray(calls)) {
          const count = Math.min(calls.length, MAX_ITEMS);
          for (let index = 0; index < count; index += 1) {
            const call = objectOf(calls[index]);
            if (!call) continue;
            const source = objectOf(own(call, 'function')) ?? call;
            const name = label(own(source, 'name'));
            const title = calls.length > 1 ? 'Tool call ' + (index + 1) : 'Tool call';
            if (own(source, 'arguments') !== undefined) result.push(code(name ? title + ' · ' + name : title, own(source, 'arguments')));
          }
          if (count < calls.length) result.push(omitted('Additional tool calls · available in Raw', calls.length - count));
        }
        if (own(message, 'note') !== undefined) result.push(text('Message note', own(message, 'note')));
        return result;
      }
      case 'prompt.steered': return content(own(payload, 'content'), 'Prompt', 'user');
      case 'turn.prompt': return content(own(payload, 'input'), 'Prompt', 'user');
      case 'turn.steer': return content(own(payload, 'input'), 'Steer', 'user');
      default: return [];
    }
  }
}

class ToolSchemaStrategy extends KimiStrategyBase {
  readonly id = 'tool-schema';
  readonly eventTypes = ['llm.tools_snapshot', 'mcp.tools_discovered', 'tools.register_user_tool'] as const;
  collect(payload: KimiEventObject): readonly KimiCandidate[] {
    switch (own(payload, 'type')) {
      case 'llm.tools_snapshot': return toolSchemas(own(payload, 'tools'), 'Tool', ['parameters']);
      case 'mcp.tools_discovered': return toolSchemas(own(payload, 'tools'), 'MCP tool', ['parameters', 'inputSchema']);
      case 'tools.register_user_tool': return [
        ...(own(payload, 'description') === undefined ? [] : [text('Tool description', own(payload, 'description'))]),
        ...(own(payload, 'parameters') === undefined ? [] : [code('Tool parameters', own(payload, 'parameters'))]),
      ];
      default: return [];
    }
  }
}

class LifecycleStrategy extends KimiStrategyBase {
  readonly id = 'lifecycle';
  readonly eventTypes = [
    'config.update', 'profile.bind', 'llm.request', 'plugin.session_start', 'prompt.aborted', 'prompt.completed',
    'task.started', 'task.terminated', 'turn.ended', 'subagent.spawned', 'subagent.started', 'subagent.completed',
    'subagent.failed', 'subagent.cancelled', 'goal.create', 'goal.update', 'cron.add', 'full_compaction.begin',
  ] as const;
  collect(payload: KimiEventObject): readonly KimiCandidate[] {
    switch (own(payload, 'type')) {
      case 'config.update':
      case 'profile.bind':
      case 'llm.request': return own(payload, 'systemPrompt') === undefined ? [] : [text('System prompt', own(payload, 'systemPrompt'))];
      case 'plugin.session_start': return own(payload, 'content') === undefined ? [] : [text('Session content', own(payload, 'content'))];
      case 'prompt.aborted':
      case 'prompt.completed': return own(payload, 'reason') === undefined ? [] : [text('Reason', own(payload, 'reason'))];
      case 'task.started':
      case 'task.terminated': {
        const info = objectOf(own(payload, 'info'));
        if (!info) return [];
        const result = taskInfoCandidates(info);
        if (own(payload, 'outputTail') !== undefined) result.push(text('Task output', own(payload, 'outputTail')));
        return result;
      }
      case 'turn.ended': {
        const error = objectOf(own(payload, 'error'));
        return [
          ...(error && own(error, 'message') !== undefined ? [text('Error', own(error, 'message'))] : []),
          ...(own(payload, 'stopReason') === undefined ? [] : [text('Stop reason', own(payload, 'stopReason'))]),
        ];
      }
      case 'subagent.spawned': return own(payload, 'description') === undefined ? [] : [text('Subagent description', own(payload, 'description'))];
      case 'subagent.started': return own(payload, 'subagentId') === undefined ? [] : [text('Subagent', own(payload, 'subagentId'))];
      case 'subagent.completed': return own(payload, 'resultSummary') === undefined ? [] : [text('Result summary', own(payload, 'resultSummary'))];
      case 'subagent.failed': return own(payload, 'error') === undefined ? [] : [text('Error', own(payload, 'error'))];
      case 'subagent.cancelled': return own(payload, 'subagentId') === undefined ? [] : [text('Cancelled subagent', own(payload, 'subagentId'))];
      case 'goal.create': return [
        ...(own(payload, 'objective') === undefined ? [] : [text('Objective', own(payload, 'objective'))]),
        ...(own(payload, 'completionCriterion') === undefined ? [] : [text('Completion criterion', own(payload, 'completionCriterion'))]),
      ];
      case 'goal.update': return own(payload, 'reason') === undefined ? [] : [text('Reason', own(payload, 'reason'))];
      case 'cron.add': {
        const task = objectOf(own(payload, 'task'));
        return task && own(task, 'prompt') !== undefined ? [text('Cron prompt', own(task, 'prompt'))] : [];
      }
      case 'full_compaction.begin': return own(payload, 'instruction') === undefined ? [] : [text('Compaction instruction', own(payload, 'instruction'))];
      default: return [];
    }
  }
}

const strategies: readonly KimiStrategyBase[] = [new LoopStrategy(), new ContentStrategy(), new ToolSchemaStrategy(), new LifecycleStrategy()];

export const kimiEventStrategyRegistry: ReadonlyMap<string, KimiEventStrategy> = new Map(
  strategies.flatMap((strategy) => strategy.eventTypes.map((eventType) => [eventType, strategy] as const)),
);

function strategyFor(payload: KimiEventObject): KimiEventStrategy | undefined {
  const eventType = label(own(payload, 'type'));
  return eventType === undefined ? undefined : kimiEventStrategyRegistry.get(eventType);
}

function estimateCandidateBytes(candidate: KimiCandidate): number {
  if (candidate.kind === 'truncated') return 0;
  if (typeof candidate.value === 'string') return candidate.value.length;
  try {
    const encoded = JSON.stringify(candidate.value);
    return typeof encoded === 'string' ? encoded.length : 0;
  } catch {
    return MAX_RENDERED_TEXT_BYTES;
  }
}

function renderKimiCandidates(candidates: readonly KimiCandidate[], context: KimiEventBuilderContext): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  let estimatedBytes = 0;
  for (const candidate of candidates) {
    if (sections.length >= MAX_RENDERED_SECTIONS) {
      sections.push({ title: 'Additional Kimi content · available in Raw', code: JSON.stringify({ omitted: candidates.length - sections.length }), language: 'json', truncated: true, previewOnly: true });
      break;
    }
    const size = estimateCandidateBytes(candidate);
    if (estimatedBytes + size > MAX_RENDERED_TEXT_BYTES) {
      sections.push({ title: 'Additional Kimi content · available in Raw', code: JSON.stringify({ omitted: candidates.length - sections.length }), language: 'json', truncated: true, previewOnly: true });
      break;
    }
    estimatedBytes += size;
    if (candidate.kind === 'text') context.addTextCandidate(sections, candidate.title, candidate.value, candidate.richText);
    else if (candidate.kind === 'code') context.addCodeCandidate(sections, candidate.title, candidate.value, candidate.language);
    else sections.push({ title: candidate.title, code: JSON.stringify({ omitted: candidate.omitted }), language: 'json', truncated: true, previewOnly: true });
  }
  return sections;
}

export function presentKimiEvent(
  payload: KimiEventObject,
  profile: AgentRowProjection | undefined,
  context: KimiEventBuilderContext,
): EventPresentationSection[] {
  const strategy = strategyFor(payload);
  return strategy?.matches(profile) ? strategy.present(payload, profile, context) : [];
}
