import type { AgentRowProjection } from '../../shared/types';
import type { EventPresentationSection } from '../features/event-presentation/model';

export type KimiEventObject = Record<string, unknown>;

export interface KimiEventBuilderContext {
  objectOf(value: unknown): KimiEventObject | undefined;
  own(object: KimiEventObject, key: string): unknown;
  valueLabel(value: unknown): string | undefined;
  addTextCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    richText?: boolean,
  ): void;
  addCodeCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    language?: string,
  ): void;
}

const MAX_KIMI_CONTENT_ITEMS = 32;

function appendKimiPart(
  context: KimiEventBuilderContext,
  sections: EventPresentationSection[],
  value: unknown,
  title: string,
  role?: string,
): void {
  const part = context.objectOf(value);
  if (!part) {
    context.addTextCandidate(sections, title, value, role === 'assistant');
    return;
  }
  const type = context.own(part, 'type');
  if (type === 'text') context.addTextCandidate(sections, title, context.own(part, 'text'), role === 'assistant');
  else if (type === 'think') {
    if (context.own(part, 'hidden') === true || context.own(part, 'encrypted') !== undefined) {
      context.addCodeCandidate(sections, 'Opaque reasoning · source flag', { type: 'think', opaque: true }, 'json');
    } else {
      context.addTextCandidate(sections, 'Reasoning', context.own(part, 'think'));
    }
  } else {
    context.addCodeCandidate(sections, `${title} · reference or structured content`, part, 'json');
  }
}

function appendKimiContent(
  context: KimiEventBuilderContext,
  sections: EventPresentationSection[],
  content: unknown,
  title: string,
  role?: string,
): void {
  if (!Array.isArray(content)) {
    appendKimiPart(context, sections, content, title, role);
    return;
  }
  const visible = Math.min(content.length, MAX_KIMI_CONTENT_ITEMS);
  for (let index = 0; index < visible; index += 1) {
    appendKimiPart(context, sections, content[index], `${title} ${index + 1}`, role);
  }
  if (visible < content.length) {
    sections.push({
      title: 'Additional content · available in Raw',
      code: JSON.stringify({ omittedBlocks: content.length - visible }),
      language: 'json',
      truncated: true,
      previewOnly: true,
    });
  }
}

/** Projects persisted Kimi event content without replaying history or resolving media. */
export function buildKimiEventSections(
  payload: KimiEventObject,
  profile: AgentRowProjection | undefined,
  context: KimiEventBuilderContext,
): EventPresentationSection[] {
  if (profile?.profileId !== 'kimi-code-session') return [];
  const sections: EventPresentationSection[] = [];
  if (payload.type === 'context.append_message') {
    const message = context.objectOf(context.own(payload, 'message'));
    if (!message) return sections;
    const role = context.valueLabel(context.own(message, 'role'));
    appendKimiContent(context, sections, context.own(message, 'content'), 'Message', role);
    const calls = context.own(message, 'toolCalls');
    if (Array.isArray(calls)) {
      const visible = Math.min(calls.length, MAX_KIMI_CONTENT_ITEMS);
      for (let index = 0; index < visible; index += 1) {
        const call = context.objectOf(calls[index]);
        if (!call) continue;
        const source = context.objectOf(context.own(call, 'function')) ?? call;
        const name = context.valueLabel(context.own(source, 'name'));
        const title = calls.length > 1 ? `Tool call ${index + 1}` : 'Tool call';
        context.addCodeCandidate(sections, name ? `${title} · ${name}` : title, context.own(source, 'arguments'), 'json');
      }
      if (visible < calls.length) {
        sections.push({
          title: 'Additional tool calls · available in Raw',
          code: JSON.stringify({ omittedCalls: calls.length - visible }),
          language: 'json',
          truncated: true,
          previewOnly: true,
        });
      }
    }
  } else if (payload.type === 'context.append_loop_event') {
    const event = context.objectOf(context.own(payload, 'event'));
    if (!event) return sections;
    if (event.type === 'content.part') {
      appendKimiPart(context, sections, context.own(event, 'part'), 'Content', 'assistant');
    } else if (event.type === 'tool.call') {
      const name = context.valueLabel(context.own(event, 'name'));
      context.addCodeCandidate(sections, name ? `Tool call · ${name}` : 'Tool call', context.own(event, 'args'), 'json');
    } else if (event.type === 'tool.result') {
      const result = context.objectOf(context.own(event, 'result'));
      if (result) {
        appendKimiContent(context, sections, context.own(result, 'output'), 'Tool result', 'tool');
        context.addTextCandidate(sections, 'Result note', context.own(result, 'note'));
      }
    }
  }
  return sections;
}
