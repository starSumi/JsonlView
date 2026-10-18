import type { AgentRowProjection } from '../../shared/types';
import type { EventPresentationSection } from '../features/event-presentation/model';

export type GenericEventObject = Record<string, unknown>;

export interface GenericEventBuilderContext {
  objectOf(value: unknown): GenericEventObject | undefined;
  own(object: GenericEventObject, key: string): unknown;
  valueLabel(value: unknown): string | undefined;
  addTextCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    richText?: boolean,
  ): void;
  addOutputCandidate(sections: EventPresentationSection[], title: string, value: unknown): void;
  addCodeCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    language?: string,
  ): void;
  appendAgentContentBlock(
    sections: EventPresentationSection[],
    block: unknown,
    title: string,
    role: string | undefined,
  ): void;
}

const MAX_CANDIDATES = 24;
const MAX_CONTENT_BLOCKS = 32;
const NESTED_KEYS = [
  'payload', 'data', 'event', 'record', 'message', 'request', 'response',
  'interaction', 'body', 'detail', 'tool_call', 'toolCall', 'tool_use', 'toolUse',
  'tool_result', 'toolResult', 'function_call', 'functionCall',
] as const;

interface Candidate {
  object: GenericEventObject;
  depth: number;
}

/** Projects provider-neutral agent envelopes without replaying or resolving them. */
export function buildGenericAgentEventSections(
  envelope: GenericEventObject,
  payload: GenericEventObject,
  profile: AgentRowProjection | undefined,
  eventType: string | undefined,
  context: GenericEventBuilderContext,
): EventPresentationSection[] {
  if (profile?.profileId !== 'generic-agent-events') return [];
  const sections: EventPresentationSection[] = [];
  const candidates = collectCandidates(envelope, payload, context);
  const role = firstLabel(candidates, context, ['role', 'actor', 'author', 'speaker']);
  const message = firstMessage(candidates, context);
  const messageContent = message
    ? firstOwn(message, context, ['content', 'parts', 'blocks', 'text', 'thinking'])
    : firstValue(candidates, context, ['content', 'parts', 'blocks', 'text', 'thinking']);

  appendContent(context, sections, messageContent, role);
  appendToolCalls(context, sections, candidates);
  appendToolResult(context, sections, candidates, eventType);

  return sections;
}

function collectCandidates(
  envelope: GenericEventObject,
  payload: GenericEventObject,
  context: GenericEventBuilderContext,
): Candidate[] {
  const result: Candidate[] = [];
  const seen = new Set<GenericEventObject>();
  const visit = (object: GenericEventObject, depth: number): void => {
    if (seen.has(object) || result.length >= MAX_CANDIDATES) return;
    seen.add(object);
    result.push({ object, depth });
    if (depth >= 3) return;
    for (const key of NESTED_KEYS) {
      const nested = context.objectOf(context.own(object, key));
      if (nested) visit(nested, depth + 1);
    }
  };
  visit(envelope, 0);
  if (payload !== envelope) visit(payload, 0);
  return result;
}

function firstMessage(
  candidates: readonly Candidate[],
  context: GenericEventBuilderContext,
): GenericEventObject | undefined {
  for (const candidate of candidates) {
    const candidateRole = firstOwn(candidate.object, context, ['role', 'actor', 'author']);
    const content = firstOwn(candidate.object, context, ['content', 'parts', 'blocks', 'text', 'thinking']);
    if (content !== undefined && (candidateRole !== undefined || candidate.object === candidates[0]?.object)) {
      return candidate.object;
    }
  }
  return undefined;
}

function appendContent(
  context: GenericEventBuilderContext,
  sections: EventPresentationSection[],
  content: unknown,
  role: string | undefined,
): void {
  if (content === undefined || content === null) return;
  if (Array.isArray(content)) {
    const visible = Math.min(content.length, MAX_CONTENT_BLOCKS);
    for (let index = 0; index < visible; index += 1) {
      const block = content[index];
      const object = context.objectOf(block);
      const type = context.valueLabel(object ? context.own(object, 'type') : undefined)?.toLowerCase();
      const title = content.length === 1
        ? (type === 'thinking' || type === 'reasoning' ? 'Reasoning' : 'Message')
        : `${type ? type.replaceAll('_', ' ') : 'Content'} ${index + 1}`;
      context.appendAgentContentBlock(sections, block, title, role);
    }
    if (content.length > visible) {
      sections.push({
        title: 'Additional content · available in Raw',
        code: JSON.stringify({ omittedBlocks: content.length - visible }),
        language: 'json',
        truncated: true,
        previewOnly: true,
      });
    }
    return;
  }
  context.addTextCandidate(sections, role === 'assistant' ? 'Message' : 'Content', content, role === 'assistant');
}

function appendToolCalls(
  context: GenericEventBuilderContext,
  sections: EventPresentationSection[],
  candidates: readonly Candidate[],
): void {
  const seen = new Set<GenericEventObject>();
  for (const candidate of candidates) {
    for (const key of ['tool_call', 'toolCall', 'tool_use', 'toolUse', 'function_call', 'functionCall', 'tool'] as const) {
      const raw = context.own(candidate.object, key);
      const values = Array.isArray(raw) ? raw.slice(0, MAX_CONTENT_BLOCKS) : [raw];
      for (const value of values) {
        const tool = context.objectOf(value);
        if (!tool || seen.has(tool)) continue;
        const name = context.valueLabel(context.own(tool, 'name'))
          ?? context.valueLabel(context.own(context.objectOf(context.own(tool, 'function')) ?? {}, 'name'));
        const input = context.own(tool, 'arguments')
          ?? context.own(tool, 'input')
          ?? context.own(tool, 'args')
          ?? context.own(context.objectOf(context.own(tool, 'function')) ?? {}, 'arguments');
        if (name === undefined && input === undefined) continue;
        seen.add(tool);
        context.addCodeCandidate(sections, name ? `Tool call · ${name}` : 'Tool call', input ?? tool, 'json');
      }
    }
  }
}

function appendToolResult(
  context: GenericEventBuilderContext,
  sections: EventPresentationSection[],
  candidates: readonly Candidate[],
  eventType: string | undefined,
): void {
  const resultEvent = /tool|function|command/i.test(eventType ?? '');
  for (const candidate of candidates) {
    for (const key of ['tool_result', 'toolResult', 'function_result', 'functionResult', 'result', 'output'] as const) {
      const value = context.own(candidate.object, key);
      if (value === undefined || value === null) continue;
      if (!resultEvent && (key === 'result' || key === 'output') && sections.length > 0) continue;
      const resultObject = context.objectOf(value);
      const nestedContent = resultObject
        ? firstOwn(resultObject, context, ['content', 'text', 'output', 'result'])
        : undefined;
      const projectedValue = nestedContent ?? value;
      if (Array.isArray(projectedValue)) {
        const visible = Math.min(projectedValue.length, MAX_CONTENT_BLOCKS);
        for (let index = 0; index < visible; index += 1) {
          context.appendAgentContentBlock(sections, projectedValue[index], visible === 1 ? 'Tool result' : `Tool result ${index + 1}`, 'tool');
        }
      } else {
        context.addOutputCandidate(sections, key === 'output' ? 'Output' : 'Tool result', projectedValue);
      }
      return;
    }
  }
}

function firstOwn(object: GenericEventObject, context: GenericEventBuilderContext, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = context.own(object, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstValue(candidates: readonly Candidate[], context: GenericEventBuilderContext, keys: readonly string[]): unknown {
  for (const candidate of candidates) {
    const value = firstOwn(candidate.object, context, keys);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstLabel(candidates: readonly Candidate[], context: GenericEventBuilderContext, keys: readonly string[]): string | undefined {
  return context.valueLabel(firstValue(candidates, context, keys));
}
