import type { AgentEventKind, AgentRowProjection, FieldPath } from '../shared/types';
import { actorFromRole, isObject, keyPath, own, usageFromObject } from './utils';

const MAX_NESTING = 2;
const MAX_CONTENT_BLOCKS = 16;
const MAX_CONTENT_CHARACTERS = 240;

const EVENT_KEYS = ['event', 'event_type', 'type', 'kind'] as const;
const NESTED_KEYS = ['payload', 'data', 'event', 'record', 'message', 'interaction', 'usage', 'body', 'detail'] as const;
const ID_KEYS = {
  sessionId: ['session_id', 'sessionId', 'session', 'conversation_id', 'conversationId'],
  turnId: ['turn_id', 'turnId', 'turn'],
  messageId: ['message_id', 'messageId', 'message_uuid', 'messageUuid'],
  parentId: ['parent_id', 'parentId', 'parent_uuid', 'parentUuid'],
  toolCallId: ['tool_call_id', 'toolCallId', 'call_id', 'callId', 'tool_use_id', 'toolUseId'],
  subagentId: ['subagent_id', 'subagentId', 'agent_id', 'agentId'],
} as const;

const DIRECT_KINDS: Record<string, AgentEventKind> = {
  session: 'session',
  turn: 'turn',
  message: 'message',
  reasoning: 'reasoning',
  think: 'reasoning',
  tool_call: 'tool_call',
  tool_use: 'tool_call',
  tool_result: 'tool_result',
  tool_output: 'tool_result',
  subagent: 'subagent',
  approval: 'approval',
  usage: 'usage',
  error: 'error',
  checkpoint: 'checkpoint',
  result: 'result',
  observation: 'observation',
  action: 'action',
  task: 'task',
};

export interface LocatedAgentValue {
  value: unknown;
  path: FieldPath;
}

export interface AgentContentInfo {
  text: string;
  path: FieldPath;
  hasThinking: boolean;
  blockKinds: string[];
  truncated: boolean;
}

export interface AgentToolInfo {
  name?: LocatedAgentValue;
  callId?: LocatedAgentValue;
  input?: LocatedAgentValue;
  result?: LocatedAgentValue;
  isError?: LocatedAgentValue;
}

export interface GenericAgentEvent {
  eventKind: AgentEventKind;
  eventName?: string;
  event?: LocatedAgentValue;
  summary?: LocatedAgentValue;
  role?: LocatedAgentValue;
  actor?: AgentRowProjection['actor'];
  timestamp?: LocatedAgentValue;
  sessionId?: LocatedAgentValue;
  turnId?: LocatedAgentValue;
  messageId?: LocatedAgentValue;
  parentId?: LocatedAgentValue;
  toolCallId?: LocatedAgentValue;
  subagentId?: LocatedAgentValue;
  model?: LocatedAgentValue;
  status?: LocatedAgentValue;
  severity?: LocatedAgentValue;
  content?: AgentContentInfo;
  tool?: AgentToolInfo;
  usage?: { value: NonNullable<AgentRowProjection['usage']>; path: FieldPath };
  semanticSignal: boolean;
  stableIdentityCount: number;
  recognized: boolean;
}

interface Candidate {
  value: Record<string, unknown>;
  path: FieldPath;
}

/**
 * Bounded, provider-neutral event extraction. It never mutates the source or
 * walks arbitrary payload trees; only known envelope keys are followed.
 */
export function adaptGenericAgentEvent(value: unknown): GenericAgentEvent | undefined {
  if (!isObject(value)) return undefined;
  const candidates = collectCandidates(value);
  const event = locate(candidates, EVENT_KEYS);
  const eventName = scalar(event?.value);
  const eventKind = classifyEvent(eventName, candidates);
  const role = locate(candidates, ['role', 'actor', 'author']);
  const content = extractContent(candidates);
  const tool = extractTool(candidates, eventKind);
  const ids = {
    sessionId: locate(candidates, ID_KEYS.sessionId),
    turnId: locate(candidates, ID_KEYS.turnId),
    messageId: locate(candidates, ID_KEYS.messageId),
    parentId: locate(candidates, ID_KEYS.parentId),
    toolCallId: tool?.callId ?? locate(candidates, ID_KEYS.toolCallId),
    subagentId: locate(candidates, ID_KEYS.subagentId),
  };
  const model = locate(candidates, ['model', 'model_name', 'modelName']);
  const status = locate(candidates, ['status', 'state', 'finishReason', 'finish_reason']);
  const severity = locate(candidates, ['severity', 'level']);
  const timestamp = locateTimestamp(candidates);
  const usage = extractUsage(candidates, eventKind);
  const summary = content?.text ? { value: content.text, path: content.path } :
    locate(candidates, ['summary', 'text', 'message', 'output', 'result', 'reason', 'description']);
  const stableIdentityCount = Object.values(ids).filter((item) => scalar(item?.value) !== undefined).length;
  const semanticSignal = Boolean(role || content || tool || usage || status || severity);
  const recognized = Boolean(eventName && eventKind !== 'other') && semanticSignal;

  return {
    eventKind,
    ...(eventName ? { eventName } : {}),
    ...(event ? { event } : {}),
    ...(summary ? { summary } : {}),
    ...(role ? { role } : {}),
    ...(actorFromRole(scalar(role?.value)) ? { actor: actorFromRole(scalar(role?.value)) } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(ids.sessionId ? { sessionId: ids.sessionId } : {}),
    ...(ids.turnId ? { turnId: ids.turnId } : {}),
    ...(ids.messageId ? { messageId: ids.messageId } : {}),
    ...(ids.parentId ? { parentId: ids.parentId } : {}),
    ...(ids.toolCallId ? { toolCallId: ids.toolCallId } : {}),
    ...(ids.subagentId ? { subagentId: ids.subagentId } : {}),
    ...(model ? { model } : {}),
    ...(status ? { status } : {}),
    ...(severity ? { severity } : {}),
    ...(content ? { content } : {}),
    ...(tool ? { tool } : {}),
    ...(usage ? { usage } : {}),
    semanticSignal,
    stableIdentityCount,
    recognized,
  };
}

function collectCandidates(root: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<Record<string, unknown>>();
  const visit = (value: Record<string, unknown>, path: FieldPath, depth: number): void => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, path });
    if (depth >= MAX_NESTING) return;
    for (const key of NESTED_KEYS) {
      const nested = own(value, key);
      if (isObject(nested)) visit(nested, appendPath(path, key), depth + 1);
    }
  };
  visit(root, keyPath(), 0);
  return out;
}

function locate(candidates: readonly Candidate[], keys: readonly string[]): LocatedAgentValue | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = own(candidate.value, key);
      if (value !== undefined && value !== null) return { value, path: appendPath(candidate.path, key) };
    }
  }
  return undefined;
}

function locateTimestamp(candidates: readonly Candidate[]): LocatedAgentValue | undefined {
  const located = locate(candidates, ['timestamp', 'time', 'created_at', 'createdAt']);
  if (!located) return undefined;
  const raw = located.value;
  if (typeof raw === 'string' && raw.length > 0) return { value: raw, path: located.path };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const milliseconds = Math.abs(raw) < 1e12 ? raw * 1000 : raw;
  const iso = new Date(milliseconds).toISOString();
  return Number.isNaN(Date.parse(iso)) ? undefined : { value: iso, path: located.path };
}

function extractContent(candidates: readonly Candidate[]): AgentContentInfo | undefined {
  const located = locate(candidates, ['content', 'text', 'reasoning', 'thinking', 'think', 'output', 'message']);
  if (!located) return undefined;
  const parts: string[] = [];
  const blockKinds: string[] = [];
  let hasThinking = false;
  let truncated = false;
  const append = (text: string): void => {
    if (parts.join(' ').length >= MAX_CONTENT_CHARACTERS) { truncated = true; return; }
    const remaining = MAX_CONTENT_CHARACTERS - parts.join(' ').length;
    parts.push(text.slice(0, remaining));
    if (text.length > remaining) truncated = true;
  };
  const raw = located.value;
  if (typeof raw === 'string') append(raw);
  else if (Array.isArray(raw)) {
    for (const [index, block] of raw.slice(0, MAX_CONTENT_BLOCKS).entries()) {
      if (index === MAX_CONTENT_BLOCKS - 1 && raw.length > MAX_CONTENT_BLOCKS) truncated = true;
      if (typeof block === 'string') { append(block); continue; }
      if (!isObject(block)) continue;
      const kind = scalar(own(block, 'type')) ?? scalar(own(block, 'kind'));
      if (kind) blockKinds.push(kind);
      const lower = kind?.toLowerCase();
      if (lower === 'thinking' || lower === 'think' || lower === 'reasoning') hasThinking = true;
      const text = scalar(own(block, 'text')) ?? scalar(own(block, 'thinking')) ?? scalar(own(block, 'think')) ?? scalar(own(block, 'content'));
      if (text) append(text);
      else if (lower && ['image', 'image_url', 'audio', 'audio_url', 'video', 'video_url'].includes(lower)) append(`[${lower} reference]`);
      else if (lower) append(`[${lower}]`);
    }
  } else if (isObject(raw)) {
    const text = scalar(own(raw, 'text')) ?? scalar(own(raw, 'content')) ?? scalar(own(raw, 'output'));
    if (text) append(text);
  }
  if (parts.length === 0 && blockKinds.length === 0) return undefined;
  return { text: parts.join(' ').trim(), path: located.path, hasThinking, blockKinds, truncated };
}

function extractTool(candidates: readonly Candidate[], eventKind: AgentEventKind): AgentToolInfo | undefined {
  const name = locate(candidates, ['tool_name', 'toolName', 'name', 'function_name', 'functionName']);
  const input = locate(candidates, ['input', 'arguments', 'parameters', 'args']);
  const result = locate(candidates, ['tool_result', 'result', 'output']);
  const isError = locate(candidates, ['is_error', 'isError', 'error']);
  const callId = locate(candidates, ID_KEYS.toolCallId);
  const toolLike = eventKind === 'tool_call' || eventKind === 'tool_result' || eventKind === 'action' || name !== undefined || callId !== undefined;
  if (!toolLike) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    ...(input ? { input } : {}),
    ...(result ? { result } : {}),
    ...(isError ? { isError } : {}),
  };
}

function extractUsage(candidates: readonly Candidate[], eventKind: AgentEventKind): GenericAgentEvent['usage'] {
  const located = locate(candidates, ['usage', 'token_usage', 'tokenUsage']);
  const value = located?.value;
  const usage = normalizeUsage(value) ?? (eventKind === 'usage' ? normalizeUsage(candidates[0]?.value) : undefined);
  if (!usage) return undefined;
  return { value: usage, path: located?.path ?? keyPath() };
}

function normalizeUsage(value: unknown): NonNullable<AgentRowProjection['usage']> | undefined {
  const generic = usageFromObject(value);
  if (generic) return generic;
  if (!isObject(value)) return undefined;
  const input = number(value, ['inputOther', 'input', 'prompt_tokens']);
  const cached = number(value, ['inputCacheRead', 'cached', 'cached_tokens', 'cache_read_input_tokens']);
  const output = number(value, ['output', 'completion_tokens']);
  const totalInput = input !== undefined && cached !== undefined ? input + cached : input;
  if (totalInput === undefined && cached === undefined && output === undefined) return undefined;
  const total = totalInput !== undefined && output !== undefined ? totalInput + output : undefined;
  return {
    ...(totalInput !== undefined ? { input: totalInput } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

function number(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const candidate = own(value, key);
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return undefined;
}

function classifyEvent(eventName: string | undefined, candidates: readonly Candidate[]): AgentEventKind {
  const raw = eventName?.toLowerCase().replace(/[.\s-]+/g, '_');
  if (raw && DIRECT_KINDS[raw]) return DIRECT_KINDS[raw];
  if (raw) {
    if (raw.includes('usage') || raw.includes('token')) return 'usage';
    if (raw.includes('error') || raw.includes('fail') || raw.includes('abort')) return 'error';
    if (raw.includes('tool') && (raw.includes('result') || raw.includes('output'))) return 'tool_result';
    if (raw.includes('tool') || raw.includes('function_call') || raw.includes('interaction')) return 'tool_call';
    if (raw.includes('reason') || raw.includes('think')) return 'reasoning';
    if (raw.includes('message') || raw.includes('prompt')) return 'message';
    if (raw.includes('subagent') || raw.includes('delegate')) return 'subagent';
    if (raw.includes('session') || raw === 'metadata') return 'session';
    if (raw.includes('turn') || raw.includes('step')) return 'turn';
    if (raw.includes('checkpoint') || raw.includes('compact')) return 'checkpoint';
    if (raw.includes('result')) return 'result';
    if (raw.includes('observe')) return 'observation';
    if (raw.includes('action')) return 'action';
    if (raw.includes('task')) return 'task';
  }
  const nestedType = locate(candidates, ['type', 'kind']);
  const nested = scalar(nestedType?.value)?.toLowerCase().replace(/[.\s-]+/g, '_');
  if (nested && nested !== raw && DIRECT_KINDS[nested]) return DIRECT_KINDS[nested];
  return 'other';
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function appendPath(base: FieldPath, key: string): FieldPath {
  return { tokens: [...base.tokens, { kind: 'key', value: key }] };
}
