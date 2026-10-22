import type { AgentRowProjection } from '../../shared/types';
import { KIMI_SOURCE_REVISION } from '../../profiles/kimi-record';
import {
  decodeKimiServerEvent,
  type KimiServerEvent,
  type KimiServerEventType,
} from '../../profiles/kimi-server-record';
import { assertNever } from '../shared/utils/exhaustiveness';
import type { EventPresentationSection } from '../features/event-presentation/model';
import type { KimiEventBuilderContext, KimiEventObject } from './kimi-event-builder';

const MAX_ITEMS = 32;
const MAX_RENDERED_SECTIONS = 96;
const MAX_RENDERED_TEXT_BYTES = 128 * 1024;

/** Source-anchored contract for this exhaustive table. */
export const KIMI_WIRE_MANIFEST_REVISION: string = KIMI_SOURCE_REVISION;
export const KIMI_CURRENT_RECORD_COUNT: number = 64;
export const KIMI_HISTORICAL_RECORD_COUNT: number = 0;

/** Current records from the pinned manifest; newer or historical keys remain Raw-only. */
export const KIMI_EVENT_TYPES = [
  'config.update', 'context.append_loop_event', 'context.append_message',
  'context.apply_compaction', 'context.clear', 'context.undo',
  'cron.add', 'cron.cursor', 'cron.delete', 'file_history.checkpoint', 'file_history.tracked', 'forked',
  'full_compaction.begin', 'full_compaction.cancel', 'full_compaction.complete', 'goal.clear', 'goal.create',
  'goal.update', 'interaction.request', 'interaction.resolved', 'interruptionReminder.recorded', 'llm.request',
  'llm.tools_snapshot', 'mcp.tools_discovered',
  'permission.record_approval_result', 'permission.set_mode', 'plan_mode.cancel', 'plan_mode.enter',
  'plan_mode.exit', 'plan.revision', 'plugin.session_start', 'profile.bind', 'prompt.aborted',
  'prompt.completed', 'prompt.steered', 'runtime.set_binding',
  'subagent.cancelled', 'subagent.completed', 'subagent.failed', 'subagent.spawned',
  'subagent.started', 'swarm_mode.enter', 'swarm_mode.exit', 'task.started', 'task.terminated',
  'task.waitDelivered', 'token_counting.measured', 'token_counting.rebased', 'token_counting.truncated',
  'token_counting.turn_recorded', 'tools.register_user_tool', 'tools.reset_active_tools',
  'tools.set_active_tools', 'tools.unregister_user_tool', 'tools.update_store', 'tower_mode.enter',
  'tower_mode.exit', 'turn.cancel', 'turn.ended', 'turn.prompt', 'turn.steer', 'turn.step.interrupted',
  'turn.step.retrying', 'usage.record',
] as const;
const KIMI_EVENT_TYPE_SET: ReadonlySet<string> = new Set(KIMI_EVENT_TYPES);

export type KimiEventType = (typeof KIMI_EVENT_TYPES)[number];

export type KimiCandidate =
  | { kind: 'text'; title: string; value: unknown; richText?: boolean }
  | { kind: 'code'; title: string; value: unknown; language?: string }
  | { kind: 'truncated'; title: string; omitted: number };

type KimiRecord<T extends string> = KimiEventObject & { type: T };

type KimiContentPart =
  | (KimiRecord<'text'> & { text: string })
  | (KimiRecord<'think'> & { think: string; hidden?: boolean; encrypted?: string })
  | (KimiRecord<'image_url'> & { imageUrl: KimiEventObject })
  | (KimiRecord<'audio_url'> & { audioUrl: KimiEventObject })
  | (KimiRecord<'video_url'> & { videoUrl: KimiEventObject });

type KimiLoopEvent =
  | (KimiRecord<'step.begin'> & { uuid?: unknown; turnId?: unknown; step?: unknown })
  | (KimiRecord<'step.end'> & {
      uuid?: unknown; turnId?: unknown; step?: unknown; finishReason?: unknown; usage?: unknown;
      llmFirstTokenLatencyMs?: unknown; llmStreamDurationMs?: unknown; messageId?: unknown;
      providerFinishReason?: unknown; rawFinishReason?: unknown;
    })
  | (KimiRecord<'content.part'> & { part: KimiContentPart })
  | (KimiRecord<'tool.call'> & { name?: unknown; args?: unknown; extras?: unknown; display?: unknown; command?: unknown })
  | (KimiRecord<'tool.result'> & {
      result: KimiEventObject & { output: string | readonly KimiContentPart[]; isError?: boolean; note?: string; durationMs?: number };
      output?: unknown;
    });

type KimiPayloadFields<K extends KimiEventType> =
  K extends 'context.append_loop_event' ? { event: KimiLoopEvent } :
  K extends 'context.append_message' ? { message?: unknown } :
  K extends 'llm.tools_snapshot' | 'mcp.tools_discovered' ? { tools?: unknown } :
  KimiEventObject;

export type KimiPayloadOf<K extends KimiEventType> = KimiRecord<K> & KimiPayloadFields<K>;
export type KimiKnownPayload = { [K in KimiEventType]: KimiPayloadOf<K> }[KimiEventType];

export type KimiDecodeResult =
  | { kind: 'known'; payload: KimiKnownPayload }
  | { kind: 'unknown'; reason: 'non-object' | 'event-type'; raw?: KimiEventObject }
  | { kind: 'invalid'; reason: 'payload-shape' | 'nested-event'; raw: KimiEventObject };

export interface KimiEventStrategy {
  readonly id: 'loop' | 'content' | 'tool-schema' | 'lifecycle' | 'raw';
}

const own = (object: KimiEventObject, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined;
const objectOf = (value: unknown): KimiEventObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as KimiEventObject : undefined;
const label = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const text = (title: string, value: unknown, richText = false): KimiCandidate => ({ kind: 'text', title, value, ...(richText ? { richText } : {}) });
const code = (title: string, value: unknown, language = 'json'): KimiCandidate => ({ kind: 'code', title, value, language });
const omitted = (title: string, count: number): KimiCandidate => ({ kind: 'truncated', title, omitted: count });

function parseContentPart(value: unknown): KimiContentPart | undefined {
  const item = objectOf(value);
  if (!item) return undefined;
  switch (own(item, 'type')) {
    case 'text': return typeof own(item, 'text') === 'string' ? item as KimiContentPart & { type: 'text' } : undefined;
    case 'think': {
      if (typeof own(item, 'think') !== 'string') return undefined;
      if (own(item, 'hidden') !== undefined && typeof own(item, 'hidden') !== 'boolean') return undefined;
      if (own(item, 'encrypted') !== undefined && typeof own(item, 'encrypted') !== 'string') return undefined;
      return item as KimiContentPart & { type: 'think' };
    }
    case 'image_url': {
      const image = objectOf(own(item, 'imageUrl'));
      return typeof image?.url === 'string' ? item as KimiContentPart & { type: 'image_url' } : undefined;
    }
    case 'audio_url': {
      const audio = objectOf(own(item, 'audioUrl'));
      return typeof audio?.url === 'string' ? item as KimiContentPart & { type: 'audio_url' } : undefined;
    }
    case 'video_url': {
      const video = objectOf(own(item, 'videoUrl'));
      return typeof video?.url === 'string' ? item as KimiContentPart & { type: 'video_url' } : undefined;
    }
    default: return undefined;
  }
}

function parseLoopEvent(value: unknown): KimiLoopEvent | undefined {
  const event = objectOf(value);
  if (!event) return undefined;
  switch (own(event, 'type')) {
    case 'step.begin': return event as KimiLoopEvent & { type: 'step.begin' };
    case 'step.end': return event as KimiLoopEvent & { type: 'step.end' };
    case 'content.part': {
      const part = parseContentPart(own(event, 'part'));
      return part === undefined ? undefined : { ...event, part, type: 'content.part' } as KimiLoopEvent & { type: 'content.part' };
    }
    case 'tool.call': return event as KimiLoopEvent & { type: 'tool.call' };
    case 'tool.result': {
      const result = objectOf(own(event, 'result'));
      if (result === undefined) return undefined;
      const output = own(result, 'output');
      const validOutput = typeof output === 'string'
        || (Array.isArray(output) && output.every((part) => parseContentPart(part) !== undefined));
      if (!validOutput) return undefined;
      if (own(result, 'isError') !== undefined && typeof own(result, 'isError') !== 'boolean') return undefined;
      if (own(result, 'note') !== undefined && typeof own(result, 'note') !== 'string') return undefined;
      if (own(result, 'durationMs') !== undefined && typeof own(result, 'durationMs') !== 'number') return undefined;
      return { ...event, result: { ...result, output }, type: 'tool.result' } as KimiLoopEvent & { type: 'tool.result' };
    }
    default: return undefined;
  }
}

/** Decode the untrusted JSON boundary before any exhaustive match is used. */
export function decodeKimiEvent(value: unknown): KimiDecodeResult {
  const payload = objectOf(value);
  if (!payload) return { kind: 'unknown', reason: 'non-object' };
  const type = label(own(payload, 'type'));
  if (type === undefined || !KIMI_EVENT_TYPE_SET.has(type)) {
    return { kind: 'unknown', reason: 'event-type', raw: payload };
  }
  if (type === 'context.append_loop_event') {
    const event = parseLoopEvent(own(payload, 'event'));
    if (event === undefined) return { kind: 'invalid', reason: 'nested-event', raw: payload };
    return { kind: 'known', payload: { ...payload, type, event } as KimiPayloadOf<'context.append_loop_event'> };
  }
  if (type === 'context.append_message' && objectOf(own(payload, 'message')) === undefined) {
    return { kind: 'invalid', reason: 'payload-shape', raw: payload };
  }
  if ((type === 'llm.tools_snapshot' || type === 'mcp.tools_discovered') && !Array.isArray(own(payload, 'tools'))) {
    return { kind: 'invalid', reason: 'payload-shape', raw: payload };
  }
  return { kind: 'known', payload: { ...payload, type } as KimiKnownPayload };
}

function renderDecodedPart(item: KimiContentPart, title: string, role?: string): KimiCandidate[] {
  switch (item.type) {
    case 'text': return [text(title, item.text, role === 'assistant')];
    case 'think': return item.hidden === true || item.encrypted !== undefined
      ? [code('Opaque reasoning · source flag', { type: 'think', opaque: true })]
      : [text('Reasoning', item.think)];
    case 'image_url':
    case 'audio_url':
    case 'video_url': return [code(title + ' · reference or structured content', item)];
    default: return assertNever(item);
  }
}

function renderPart(value: unknown, title: string, role?: string): KimiCandidate[] {
  const item = parseContentPart(value);
  if (item !== undefined) return renderDecodedPart(item, title, role);
  return typeof value === 'string'
    ? [text(title, value, role === 'assistant')]
    : [code(title + ' · reference or structured content', value)];
}

function content(value: unknown, title: string, role?: string): KimiCandidate[] {
  if (!Array.isArray(value)) return renderPart(value, title, role);
  const count = Math.min(value.length, MAX_ITEMS);
  const result: KimiCandidate[] = [];
  for (let index = 0; index < count; index += 1) result.push(...renderPart(value[index], title + ' ' + (index + 1), role));
  if (count < value.length) result.push(omitted('Additional content · available in Raw', value.length - count));
  return result;
}

function toolSchemas(value: unknown, prefix: string, schemaKeys: readonly string[]): KimiCandidate[] {
  if (!Array.isArray(value)) return [];
  const count = Math.min(value.length, MAX_ITEMS);
  const result: KimiCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = objectOf(value[index]);
    if (!item) { result.push(code(prefix + ' ' + (index + 1) + ' · structured content', value[index])); continue; }
    const name = label(own(item, 'name')) ?? String(index + 1);
    if (own(item, 'description') !== undefined) result.push(text(prefix + ' description · ' + name, own(item, 'description')));
    for (const key of schemaKeys) {
      const schema = own(item, key);
      if (schema !== undefined) { result.push(code(prefix + ' parameters · ' + name, schema)); break; }
    }
  }
  if (count < value.length) result.push(omitted('Additional ' + prefix.toLowerCase() + 's · available in Raw', value.length - count));
  return result;
}

function argumentObject(value: unknown): KimiEventObject | undefined {
  const direct = objectOf(value);
  if (direct) return direct;
  if (typeof value !== 'string' || value.length > MAX_RENDERED_TEXT_BYTES) return undefined;
  try { return objectOf(JSON.parse(value)); } catch { return undefined; }
}

function toolCall(event: Extract<KimiLoopEvent, { type: 'tool.call' }>): KimiCandidate[] {
  const name = label(own(event, 'name'));
  const title = name ? 'Tool call · ' + name : 'Tool call';
  const result: KimiCandidate[] = [];
  const args = own(event, 'args');
  const argsObject = argumentObject(args);
  const display = objectOf(own(event, 'display'));
  const directCommand = own(event, 'command');
  const displayCommand = display ? own(display, 'command') : undefined;
  const argsCommand = argsObject ? own(argsObject, 'command') : undefined;
  const displayAgentName = display
    ? label(own(display, 'agent_name')) ?? label(own(display, 'agentName'))
    : undefined;
  const displayPrompt = display ? own(display, 'prompt') : undefined;
  const argsPrompt = argsObject ? own(argsObject, 'prompt') : undefined;
  const prompt = displayPrompt ?? argsPrompt;
  if (directCommand !== undefined) result.push(code(name ? 'Tool command · ' + name : 'Tool command', directCommand, 'shell'));
  else if (displayCommand !== undefined) result.push(code(name ? 'Tool command · ' + name : 'Tool command', displayCommand, 'shell'));
  else if (argsCommand !== undefined) result.push(code(name ? 'Tool command · ' + name : 'Tool command', argsCommand, 'shell'));
  else if (prompt === undefined && args !== undefined) result.push(code(title, args));
  if (displayAgentName !== undefined) result.push(text('Agent', displayAgentName));
  if (prompt !== undefined) result.push(text(displayAgentName !== undefined ? 'Agent prompt' : 'Tool prompt', prompt));
  if (display && own(display, 'kind') !== undefined && (displayAgentName !== undefined || prompt !== undefined)) {
    result.push(text('Tool kind', own(display, 'kind')));
  }
  if (display && own(display, 'description') !== undefined) result.push(text(name ? 'Tool description · ' + name : 'Tool description', own(display, 'description')));
  if (own(event, 'extras') !== undefined) result.push(code(title + ' extras', own(event, 'extras')));
  return result;
}

function toolResult(event: Extract<KimiLoopEvent, { type: 'tool.result' }>): KimiCandidate[] {
  const result = event.result;
  const output = own(result, 'output') ?? own(event, 'output');
  const candidates = output === undefined ? [] : content(output, 'Tool result', 'tool');
  if (own(result, 'note') !== undefined) candidates.push(text('Result note', own(result, 'note')));
  return candidates;
}

function loopCandidates(event: KimiLoopEvent): KimiCandidate[] {
  switch (event.type) {
    case 'step.begin': return [
      ...(own(event, 'uuid') === undefined ? [] : [text('Step', own(event, 'uuid'))]),
      ...(own(event, 'turnId') === undefined ? [] : [text('Turn', own(event, 'turnId'))]),
      ...(own(event, 'step') === undefined ? [] : [text('Step index', own(event, 'step'))]),
    ];
    case 'step.end': return [
      ...(own(event, 'finishReason') === undefined ? [] : [text('Finish reason', own(event, 'finishReason'))]),
      ...(own(event, 'usage') === undefined ? [] : [code('Usage', own(event, 'usage'))]),
      ...(own(event, 'messageId') === undefined ? [] : [text('Message id', own(event, 'messageId'))]),
      ...(own(event, 'providerFinishReason') === undefined ? [] : [text('Provider finish reason', own(event, 'providerFinishReason'))]),
      ...(own(event, 'rawFinishReason') === undefined ? [] : [text('Raw finish reason', own(event, 'rawFinishReason'))]),
    ];
    case 'content.part': return renderDecodedPart(event.part, 'Content', 'assistant');
    case 'tool.call': return toolCall(event);
    case 'tool.result': return toolResult(event);
    default: return assertNever(event);
  }
}

function taskInfoCandidates(info: KimiEventObject): KimiCandidate[] {
  const result: KimiCandidate[] = [];
  for (const [key, title] of [
    ['kind', 'Task kind'], ['description', 'Task description'], ['status', 'Task status'],
    ['stopReason', 'Task stop reason'], ['timeoutMs', 'Task timeout'], ['pid', 'Task pid'],
    ['exitCode', 'Task exit code'], ['agentId', 'Task agent'], ['subagentType', 'Subagent type'],
    ['model', 'Task model'], ['thinkingEffort', 'Thinking effort'], ['stopCode', 'Task stop code'],
    ['questionCount', 'Question count'], ['toolCallId', 'Question tool call'],
  ] as const) if (own(info, key) !== undefined) result.push(text(title, own(info, key)));
  if (own(info, 'command') !== undefined) result.push(code('Task command', own(info, 'command'), 'shell'));
  return result;
}

function messageCandidates(payload: KimiPayloadOf<'context.append_message'>): KimiCandidate[] {
  const message = objectOf(payload.message);
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

type KimiServerPresentationType = Extract<KimiServerEventType,
  | 'event.session.created'
  | 'event.session.status_changed'
  | 'session.meta.updated'
  | 'prompt.submitted'
  | 'prompt.completed'
  | 'turn.started'
  | 'turn.step.started'
  | 'turn.step.completed'
  | 'turn.step.retrying'
  | 'turn.step.interrupted'
  | 'turn.ended'
  | 'context.spliced'
  | 'error'
  | 'tool.list.updated'
  | 'mcp.server.status'
  | 'event.config.warning'
>;

type KimiServerEventOf<K extends KimiServerPresentationType> = KimiServerEvent & { type: K };
type KimiServerHandler<K extends KimiServerPresentationType> = (event: KimiServerEventOf<K>) => readonly KimiCandidate[];
type KimiServerHandlerTable = { [K in KimiServerPresentationType]: (event: KimiServerEvent) => readonly KimiCandidate[] };

function adaptKimiServerHandler<K extends KimiServerPresentationType>(
  handler: KimiServerHandler<K>,
): (event: KimiServerEvent) => readonly KimiCandidate[] {
  return (event) => handler(event as KimiServerEventOf<K>);
}

function serverPayload(event: KimiServerEvent): KimiEventObject {
  return event.payload;
}

function serverText(payload: KimiEventObject, key: string, title: string): KimiCandidate[] {
  const value = own(payload, key);
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [text(title, value.slice(0, 8_000))];
  if (typeof value === 'number' || typeof value === 'boolean') return [text(title, value)];
  return [code(title + ' · structured value', safeServerRaw(value))];
}

function serverContent(value: unknown, title: string): KimiCandidate[] {
  const preview = serverContentPreview(value);
  return preview ? [text(title, preview)] : [];
}

function serverContentPreview(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 240);
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  let length = 0;
  const append = (part: string): void => {
    const prefix = parts.length === 0 ? '' : ' ';
    const available = 240 - length - prefix.length;
    if (available <= 0) return;
    const bounded = part.slice(0, available);
    parts.push(prefix + bounded);
    length += prefix.length + bounded.length;
  };
  for (let index = 0; index < Math.min(value.length, 16) && length < 240; index += 1) {
    const item = objectOf(value[index]);
    if (!item) continue;
    if (own(item, 'hidden') === true || own(item, 'opaque') === true
      || own(item, 'encrypted') !== undefined || own(item, 'signature') !== undefined) {
      append('[hidden content omitted]');
      continue;
    }
    const type = label(own(item, 'type'));
    let part: string | undefined;
    if (type === 'text') {
      const body = own(item, 'text');
      if (typeof body === 'string') part = body;
    } else if (type === 'thinking' || type === 'think') {
      const body = own(item, type);
      if (typeof body === 'string') part = body;
    } else if (type === 'image' || type === 'video' || type === 'file' || type === 'tool_use' || type === 'tool_result'
      || type === 'image_url' || type === 'audio_url' || type === 'video_url') {
      part = `[${type} reference]`;
    }
    if (part) append(part);
  }
  return parts.join('');
}

function serverStatusCandidates(session: KimiEventObject): KimiCandidate[] {
  return serverText(session, 'status', 'Session status');
}

function serverSessionCreated(event: KimiServerEventOf<'event.session.created'>): readonly KimiCandidate[] {
  const session = objectOf(own(serverPayload(event), 'session'));
  if (!session) return [];
  return [
    ...serverText(session, 'title', 'Session title'),
    ...serverText(session, 'id', 'Session id'),
    ...serverStatusCandidates(session),
    ...serverText(session, 'last_prompt', 'Last prompt'),
  ];
}

function serverSessionUpdated(event: KimiServerEventOf<'session.meta.updated'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  const patch = objectOf(own(payload, 'patch'));
  return [
    ...serverText(payload, 'title', 'Session title'),
    ...(patch ? serverText(patch, 'title', 'Session title') : []),
    ...(patch ? serverText(patch, 'lastPrompt', 'Last prompt') : []),
    ...(patch ? serverText(patch, 'status', 'Session status') : []),
  ];
}

function serverSessionStatusChanged(event: KimiServerEventOf<'event.session.status_changed'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'previous_status', 'Previous session status'),
    ...serverText(payload, 'current_status', 'Session status'),
    ...serverText(payload, 'current_prompt_id', 'Current prompt'),
  ];
}

function serverPromptSubmitted(event: KimiServerEventOf<'prompt.submitted'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverContent(own(payload, 'content'), 'Prompt'),
    ...serverText(payload, 'promptId', 'Prompt id'),
    ...serverText(payload, 'status', 'Prompt status'),
  ];
}

function serverPromptCompleted(event: KimiServerEventOf<'prompt.completed'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'reason', 'Prompt result'),
    ...serverText(payload, 'promptId', 'Prompt id'),
    ...serverText(payload, 'finishedAt', 'Finished at'),
  ];
}

function serverTurnStarted(event: KimiServerEventOf<'turn.started'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  const origin = objectOf(own(payload, 'origin'));
  return [
    ...serverText(payload, 'turnId', 'Turn'),
    ...(origin ? serverText(origin, 'kind', 'Turn origin') : []),
  ];
}

function serverStepStarted(event: KimiServerEventOf<'turn.step.started'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'turnId', 'Turn'),
    ...serverText(payload, 'step', 'Step'),
    ...serverText(payload, 'stepId', 'Step id'),
  ];
}

function serverStepCompleted(event: KimiServerEventOf<'turn.step.completed'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'step', 'Step'),
    ...serverText(payload, 'finishReason', 'Finish reason'),
    ...(own(payload, 'usage') === undefined ? [] : [code('Usage', safeServerRaw(own(payload, 'usage')))]),
    ...['llmFirstTokenLatencyMs', 'llmStreamDurationMs', 'llmRequestBuildMs', 'llmServerFirstTokenMs', 'llmServerDecodeMs', 'llmClientConsumeMs']
      .flatMap((key) => serverText(payload, key, key)),
  ];
}

function serverStepRetrying(event: KimiServerEventOf<'turn.step.retrying'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'step', 'Step'),
    ...serverText(payload, 'failedAttempt', 'Failed attempt'),
    ...serverText(payload, 'nextAttempt', 'Next attempt'),
    ...serverText(payload, 'maxAttempts', 'Maximum attempts'),
    ...serverText(payload, 'delayMs', 'Retry delay (ms)'),
    ...serverText(payload, 'errorName', 'Retry error name'),
    ...serverText(payload, 'errorMessage', 'Retry error'),
    ...serverText(payload, 'statusCode', 'Status code'),
  ];
}

function serverStepInterrupted(event: KimiServerEventOf<'turn.step.interrupted'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'step', 'Step'),
    ...serverText(payload, 'reason', 'Interruption reason'),
    ...serverText(payload, 'message', 'Interruption'),
  ];
}

function serverTurnEnded(event: KimiServerEventOf<'turn.ended'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  const error = objectOf(own(payload, 'error'));
  return [
    ...serverText(payload, 'reason', 'Turn result'),
    ...serverText(payload, 'durationMs', 'Duration (ms)'),
    ...(error ? serverText(error, 'message', 'Turn error') : []),
    ...(error ? serverText(error, 'name', 'Error name') : []),
    ...(error ? serverText(error, 'code', 'Error code') : []),
  ];
}

function serverContextSpliced(event: KimiServerEventOf<'context.spliced'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  const messages = own(payload, 'messages');
  const candidates: KimiCandidate[] = [
    ...serverText(payload, 'start', 'Splice start'),
    ...serverText(payload, 'deleteCount', 'Deleted messages'),
  ];
  if (!Array.isArray(messages)) return candidates;
  const count = Math.min(messages.length, MAX_ITEMS);
  for (let index = 0; index < count; index += 1) {
    const message = objectOf(messages[index]);
    if (!message) continue;
    const role = label(own(message, 'role'));
    const preview = serverContentPreview(own(message, 'content'));
    if (preview) candidates.push(text(`Context message ${index + 1}${role ? ` · ${role}` : ''}`, preview));
  }
  if (count < messages.length) candidates.push(omitted('Additional context messages · available in Raw', messages.length - count));
  return candidates;
}

function serverError(event: KimiServerEventOf<'error'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'code', 'Error code'),
    ...serverText(payload, 'name', 'Error name'),
    ...serverText(payload, 'message', 'Error'),
    ...serverText(payload, 'retryable', 'Retryable'),
  ];
}

function serverToolListUpdated(event: KimiServerEventOf<'tool.list.updated'>): readonly KimiCandidate[] {
  const payload = serverPayload(event);
  return [
    ...serverText(payload, 'serverName', 'MCP server'),
    ...serverText(payload, 'reason', 'Tool list update'),
  ];
}

function serverMcpStatus(event: KimiServerEventOf<'mcp.server.status'>): readonly KimiCandidate[] {
  const server = own(serverPayload(event), 'server');
  const record = objectOf(server);
  if (!record) return server === undefined ? [] : [text('MCP status', server)];
  return [
    ...serverText(record, 'name', 'MCP server'),
    ...serverText(record, 'status', 'MCP status'),
    ...serverText(record, 'toolCount', 'MCP tool count'),
    ...serverText(record, 'message', 'MCP detail'),
  ];
}

function serverConfigWarning(event: KimiServerEventOf<'event.config.warning'>): readonly KimiCandidate[] {
  const warnings = own(serverPayload(event), 'warnings');
  if (!Array.isArray(warnings)) return warnings === undefined ? [] : [text('Configuration warning', warnings)];
  const count = Math.min(warnings.length, MAX_ITEMS);
  const candidates = warnings.slice(0, count).flatMap((warning, index): KimiCandidate[] => {
    const record = objectOf(warning);
    const message = record ? own(record, 'message') : warning;
    return message === undefined ? [] : [text(`Configuration warning ${index + 1}`, message)];
  });
  if (count < warnings.length) candidates.push(omitted('Additional warnings · available in Raw', warnings.length - count));
  return candidates;
}

/** Unknown server events stay inspectable, but opaque content is never copied into the detail pane. */
function safeServerRaw(value: unknown, depth = 0, budget = { remaining: 128 }): unknown {
  if (depth > 5 || budget.remaining <= 0) return '[bounded]';
  if (typeof value === 'string') return value.slice(0, 512);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const count = Math.min(value.length, MAX_ITEMS, budget.remaining);
    const items: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      budget.remaining -= 1;
      items.push(safeServerRaw(value[index], depth + 1, budget));
    }
    if (count < value.length) items.push(`[${value.length - count} more items]`);
    return items;
  }
  const record = objectOf(value);
  if (!record) return '[unsupported]';
  if (own(record, 'hidden') === true || own(record, 'opaque') === true
    || own(record, 'encrypted') !== undefined || own(record, 'signature') !== undefined
    || own(record, 'type') === 'opaque') return '[opaque content omitted]';
  const result: Record<string, unknown> = {};
  let fieldCount = 0;
  let omittedFields = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (fieldCount >= MAX_ITEMS) {
      omittedFields += 1;
      break;
    }
    if (budget.remaining <= 0) break;
    fieldCount += 1;
    const item = record[key];
    const safeKey = key.slice(0, 80);
    if (key === 'data' || key === 'base64' || key === 'bytes') {
      result[safeKey] = '[binary content omitted]';
      continue;
    }
    budget.remaining -= 1;
    result[safeKey] = safeServerRaw(item, depth + 1, budget);
  }
  if (omittedFields > 0) result.omittedFields = 'additional fields omitted';
  return result;
}

const kimiServerEventHandlers = {
  'event.session.created': adaptKimiServerHandler(serverSessionCreated),
  'event.session.status_changed': adaptKimiServerHandler(serverSessionStatusChanged),
  'session.meta.updated': adaptKimiServerHandler(serverSessionUpdated),
  'prompt.submitted': adaptKimiServerHandler(serverPromptSubmitted),
  'prompt.completed': adaptKimiServerHandler(serverPromptCompleted),
  'turn.started': adaptKimiServerHandler(serverTurnStarted),
  'turn.step.started': adaptKimiServerHandler(serverStepStarted),
  'turn.step.completed': adaptKimiServerHandler(serverStepCompleted),
  'turn.step.retrying': adaptKimiServerHandler(serverStepRetrying),
  'turn.step.interrupted': adaptKimiServerHandler(serverStepInterrupted),
  'turn.ended': adaptKimiServerHandler(serverTurnEnded),
  'context.spliced': adaptKimiServerHandler(serverContextSpliced),
  error: adaptKimiServerHandler(serverError),
  'tool.list.updated': adaptKimiServerHandler(serverToolListUpdated),
  'mcp.server.status': adaptKimiServerHandler(serverMcpStatus),
  'event.config.warning': adaptKimiServerHandler(serverConfigWarning),
} satisfies KimiServerHandlerTable;

function collectKimiServerEvent(event: KimiServerEvent): readonly KimiCandidate[] {
  const handler = kimiServerEventHandlers[event.type as KimiServerPresentationType];
  // The checked journal envelope supplies the discriminant; payload.type is not used for dispatch.
  if (handler) return handler(event);
  return [code('Kimi server raw fallback · ' + event.type, safeServerRaw(event.payload))];
}

function systemPromptCandidates(payload: KimiPayloadOf<'config.update' | 'profile.bind' | 'llm.request'>): KimiCandidate[] {
  return own(payload, 'systemPrompt') === undefined ? [] : [text('System prompt', own(payload, 'systemPrompt'))];
}

function taskCandidates(payload: KimiPayloadOf<'task.started' | 'task.terminated'>): KimiCandidate[] {
  const info = objectOf(own(payload, 'info'));
  if (!info) return [];
  const result = taskInfoCandidates(info);
  if (own(payload, 'outputTail') !== undefined) result.push(text('Task output', own(payload, 'outputTail')));
  return result;
}

type StrategyId = KimiEventStrategy['id'];
type KimiHandler<K extends KimiEventType> = (payload: KimiPayloadOf<K>) => readonly KimiCandidate[];
type KimiHandlerEntry<K extends KimiEventType> = { strategy: StrategyId; collect: KimiHandler<K> };
type KimiHandlerTable = { [K in KimiEventType]: KimiHandlerEntry<K> };
const emptyHandler = <K extends KimiEventType>(_payload: KimiPayloadOf<K>): readonly KimiCandidate[] => [];

/** Every upstream wire key has an explicit policy: semantic projection or Raw fallback. */
export const kimiEventHandlers: KimiHandlerTable = {
  'config.update': { strategy: 'lifecycle', collect: systemPromptCandidates },
  'context.append_loop_event': { strategy: 'loop', collect: (payload) => loopCandidates(payload.event) },
  'context.append_message': { strategy: 'content', collect: messageCandidates },
  'context.apply_compaction': { strategy: 'lifecycle', collect: (payload) => own(payload, 'summary') === undefined ? [] : [text('Summary', own(payload, 'summary'))] },
  'context.clear': { strategy: 'raw', collect: emptyHandler },
  'context.undo': { strategy: 'raw', collect: emptyHandler },
  'cron.add': { strategy: 'lifecycle', collect: (payload) => { const task = objectOf(own(payload, 'task')); return task && own(task, 'prompt') !== undefined ? [text('Cron prompt', own(task, 'prompt'))] : []; } },
  'cron.cursor': { strategy: 'raw', collect: emptyHandler },
  'cron.delete': { strategy: 'raw', collect: emptyHandler },
  'file_history.checkpoint': { strategy: 'raw', collect: emptyHandler },
  'file_history.tracked': { strategy: 'raw', collect: emptyHandler },
  forked: { strategy: 'raw', collect: emptyHandler },
  'full_compaction.begin': { strategy: 'lifecycle', collect: (payload) => own(payload, 'instruction') === undefined ? [] : [text('Compaction instruction', own(payload, 'instruction'))] },
  'full_compaction.cancel': { strategy: 'raw', collect: emptyHandler },
  'full_compaction.complete': { strategy: 'raw', collect: emptyHandler },
  'goal.clear': { strategy: 'raw', collect: emptyHandler },
  'goal.create': { strategy: 'lifecycle', collect: (payload) => [
    ...(own(payload, 'objective') === undefined ? [] : [text('Objective', own(payload, 'objective'))]),
    ...(own(payload, 'completionCriterion') === undefined ? [] : [text('Completion criterion', own(payload, 'completionCriterion'))]),
  ] },
  'goal.update': { strategy: 'lifecycle', collect: (payload) => own(payload, 'reason') === undefined ? [] : [text('Reason', own(payload, 'reason'))] },
  'interaction.request': { strategy: 'raw', collect: emptyHandler },
  'interaction.resolved': { strategy: 'raw', collect: emptyHandler },
  'interruptionReminder.recorded': { strategy: 'raw', collect: emptyHandler },
  'llm.request': { strategy: 'lifecycle', collect: systemPromptCandidates },
  'llm.tools_snapshot': { strategy: 'tool-schema', collect: (payload) => toolSchemas(own(payload, 'tools'), 'Tool', ['parameters']) },
  'mcp.tools_discovered': { strategy: 'tool-schema', collect: (payload) => toolSchemas(own(payload, 'tools'), 'MCP tool', ['parameters', 'inputSchema']) },
  'permission.record_approval_result': { strategy: 'raw', collect: emptyHandler },
  'permission.set_mode': { strategy: 'raw', collect: emptyHandler },
  'plan_mode.cancel': { strategy: 'raw', collect: emptyHandler },
  'plan_mode.enter': { strategy: 'raw', collect: emptyHandler },
  'plan_mode.exit': { strategy: 'raw', collect: emptyHandler },
  'plan.revision': { strategy: 'raw', collect: emptyHandler },
  'plugin.session_start': { strategy: 'lifecycle', collect: (payload) => own(payload, 'content') === undefined ? [] : [text('Session content', own(payload, 'content'))] },
  'profile.bind': { strategy: 'lifecycle', collect: systemPromptCandidates },
  'prompt.aborted': { strategy: 'lifecycle', collect: (payload) => own(payload, 'reason') === undefined ? [] : [text('Reason', own(payload, 'reason'))] },
  'prompt.completed': { strategy: 'lifecycle', collect: (payload) => own(payload, 'reason') === undefined ? [] : [text('Reason', own(payload, 'reason'))] },
  'prompt.steered': { strategy: 'content', collect: (payload) => content(own(payload, 'content'), 'Prompt', 'user') },
  'runtime.set_binding': { strategy: 'raw', collect: emptyHandler },
  'subagent.cancelled': { strategy: 'lifecycle', collect: (payload) => own(payload, 'subagentId') === undefined ? [] : [text('Cancelled subagent', own(payload, 'subagentId'))] },
  'subagent.completed': { strategy: 'lifecycle', collect: (payload) => own(payload, 'resultSummary') === undefined ? [] : [text('Result summary', own(payload, 'resultSummary'))] },
  'subagent.failed': { strategy: 'lifecycle', collect: (payload) => own(payload, 'error') === undefined ? [] : [text('Error', own(payload, 'error'))] },
  'subagent.spawned': { strategy: 'lifecycle', collect: (payload) => own(payload, 'description') === undefined ? [] : [text('Subagent description', own(payload, 'description'))] },
  'subagent.started': { strategy: 'lifecycle', collect: (payload) => own(payload, 'subagentId') === undefined ? [] : [text('Subagent', own(payload, 'subagentId'))] },
  'swarm_mode.enter': { strategy: 'raw', collect: emptyHandler },
  'swarm_mode.exit': { strategy: 'raw', collect: emptyHandler },
  'task.started': { strategy: 'lifecycle', collect: taskCandidates },
  'task.terminated': { strategy: 'lifecycle', collect: taskCandidates },
  'task.waitDelivered': { strategy: 'raw', collect: emptyHandler },
  'token_counting.measured': { strategy: 'raw', collect: emptyHandler },
  'token_counting.rebased': { strategy: 'raw', collect: emptyHandler },
  'token_counting.truncated': { strategy: 'raw', collect: emptyHandler },
  'token_counting.turn_recorded': { strategy: 'raw', collect: emptyHandler },
  'tools.register_user_tool': { strategy: 'tool-schema', collect: (payload) => [
    ...(own(payload, 'description') === undefined ? [] : [text('Tool description', own(payload, 'description'))]),
    ...(own(payload, 'parameters') === undefined ? [] : [code('Tool parameters', own(payload, 'parameters'))]),
  ] },
  'tools.reset_active_tools': { strategy: 'raw', collect: emptyHandler },
  'tools.set_active_tools': { strategy: 'raw', collect: emptyHandler },
  'tools.unregister_user_tool': { strategy: 'raw', collect: emptyHandler },
  'tools.update_store': { strategy: 'raw', collect: emptyHandler },
  'tower_mode.enter': { strategy: 'raw', collect: emptyHandler },
  'tower_mode.exit': { strategy: 'raw', collect: emptyHandler },
  'turn.cancel': { strategy: 'raw', collect: emptyHandler },
  'turn.ended': { strategy: 'lifecycle', collect: (payload) => {
    const error = objectOf(own(payload, 'error'));
    return [
      ...(error && own(error, 'message') !== undefined ? [text('Error', own(error, 'message'))] : []),
      ...(own(payload, 'stopReason') === undefined ? [] : [text('Stop reason', own(payload, 'stopReason'))]),
    ];
  } },
  'turn.prompt': { strategy: 'content', collect: (payload) => content(own(payload, 'input'), 'Prompt', 'user') },
  'turn.steer': { strategy: 'content', collect: (payload) => content(own(payload, 'input'), 'Steer', 'user') },
  'turn.step.interrupted': { strategy: 'raw', collect: emptyHandler },
  'turn.step.retrying': { strategy: 'raw', collect: emptyHandler },
  'usage.record': { strategy: 'raw', collect: emptyHandler },
} satisfies KimiHandlerTable;

const strategyDefinitions = {
  loop: { id: 'loop' },
  content: { id: 'content' },
  'tool-schema': { id: 'tool-schema' },
  lifecycle: { id: 'lifecycle' },
  raw: { id: 'raw' },
} satisfies Record<StrategyId, KimiEventStrategy>;

export const kimiEventStrategyRegistry: ReadonlyMap<KimiEventType, KimiEventStrategy> = new Map(
  KIMI_EVENT_TYPES.map((eventType) => [eventType, strategyDefinitions[kimiEventHandlers[eventType].strategy]] as const),
);

function renderUnknown(
  decoded: Extract<KimiDecodeResult, { kind: 'unknown' | 'invalid' }>,
  context: KimiEventBuilderContext,
): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  context.addCodeCandidate(sections, 'Kimi raw fallback · unknown event', {
    provider: 'kimi-code',
    reason: decoded.reason,
    source: 'Raw',
  });
  return sections;
}

function collectKnown<K extends KimiEventType>(payload: KimiPayloadOf<K>): readonly KimiCandidate[] {
  // Indexed access loses the key/value correlation; this is the single typed
  // dispatch boundary. The mapped table remains compile-time complete.
  const entry = kimiEventHandlers[payload.type] as KimiHandlerEntry<K>;
  return entry.collect(payload);
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
  if (profile?.profileId !== 'kimi-code-session') return [];
  const serverEvent = decodeKimiServerEvent(payload);
  if (serverEvent) return renderKimiCandidates(collectKimiServerEvent(serverEvent), context);
  // A physical Kimi server journal record must never fall through to the legacy
  // agent-core wire decoder when the server envelope is malformed. Agent-core
  // records also use kind=event, so the journal boundary needs a journal
  // marker before it can claim a malformed server record.
  const looksLikeServerJournal = own(payload, 'kind') === 'event'
    && (own(payload, 'seq') !== undefined || own(payload, 'envelope') !== undefined);
  if (looksLikeServerJournal) {
    return renderKimiCandidates([code('Kimi server raw fallback · malformed journal event', {
      provider: 'kimi-code-server',
      reason: 'invalid journal envelope',
      source: 'Raw',
    })], context);
  }
  // Older agent-core append records wrap the actual message one level deeper
  // than context.append_message. Keep this compatibility path separate from
  // the current manifest so the source-backed event table stays exhaustive.
  if (own(payload, 'type') === 'agent.message.appended' && own(payload, 'kind') === 'event') {
    const envelope = objectOf(own(payload, 'message'));
    const message = envelope ? objectOf(own(envelope, 'message')) : undefined;
    if (message && label(own(message, 'role')) !== undefined && Array.isArray(own(message, 'content'))) {
      return renderKimiCandidates(messageCandidates({
        ...payload,
        type: 'context.append_message',
        message,
      } as KimiPayloadOf<'context.append_message'>), context);
    }
  }
  const decoded = decodeKimiEvent(payload);
  if (decoded.kind !== 'known') return renderUnknown(decoded, context);
  return renderKimiCandidates(collectKnown(decoded.payload), context);
}
