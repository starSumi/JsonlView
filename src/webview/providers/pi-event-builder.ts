import type { AgentRowProjection } from '../../shared/types';
import type { EventPresentationSection } from '../features/event-presentation/model';

export type PiEventObject = Record<string, unknown>;

export interface PiEventBuilderContext {
  objectOf(value: unknown): PiEventObject | undefined;
  own(object: PiEventObject, key: string): unknown;
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
  addTextDiffCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    alreadyTruncated?: boolean,
  ): boolean;
  addDiffCandidate(sections: EventPresentationSection[], title: string, value: unknown): boolean;
  appendAgentContentBlock(
    sections: EventPresentationSection[],
    block: unknown,
    title: string,
    role: string | undefined,
  ): void;
}

function addPiToolDetailDiffs(
  context: PiEventBuilderContext,
  sections: EventPresentationSection[],
  details: unknown,
): void {
  const detailObject = context.objectOf(details);
  if (!detailObject) return;
  for (const key of ['diff', 'patch'] as const) {
    const value = context.own(detailObject, key);
    const title = 'Details ' + key;
    if (typeof value === 'string') {
      context.addTextDiffCandidate(sections, title, value);
    } else if (!context.addDiffCandidate(sections, title, value) && value !== undefined) {
      context.addCodeCandidate(sections, title, value, 'json');
    }
  }
}

function piCustomMessageSections(
  context: PiEventBuilderContext,
  payload: PiEventObject,
): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  context.addTextCandidate(sections, 'Custom type', context.own(payload, 'customType'));
  context.addCodeCandidate(sections, 'Display', context.own(payload, 'display'), 'json');
  const content = context.own(payload, 'content');
  if (Array.isArray(content)) {
    const visible = Math.min(content.length, 32);
    for (let index = 0; index < visible; index += 1) {
      const block = content[index];
      const blockObject = context.objectOf(block);
      const type = context.valueLabel(context.own(blockObject ?? {}, 'type'))?.toLowerCase() ?? 'content';
      const title = content.length === 1 && type === 'text'
        ? 'Custom message'
        : `Custom ${type.replaceAll('_', ' ')} ${String(index + 1)}`;
      context.appendAgentContentBlock(sections, block, title, 'agent');
    }
    if (content.length > visible) {
      sections.push({
        title: 'Additional custom message content',
        code: JSON.stringify({ omittedBlocks: content.length - visible }, null, 2),
        truncated: true,
        previewOnly: true,
        language: 'json',
      });
    }
  } else if (content !== undefined) {
    context.addTextCandidate(sections, 'Custom message', content, false);
    if (!sections.some((section) => section.title === 'Custom message')) {
      context.addCodeCandidate(sections, 'Custom content', content, 'json');
    }
  }
  context.addCodeCandidate(sections, 'Custom details', context.own(payload, 'details'), 'json');
  return sections;
}

function piMessageSections(
  context: PiEventBuilderContext,
  payload: PiEventObject,
): EventPresentationSection[] {
  const message = context.objectOf(context.own(payload, 'message'));
  if (!message) return [];
  const sections: EventPresentationSection[] = [];
  const role = context.valueLabel(context.own(message, 'role'))?.toLowerCase();
  const content = context.own(message, 'content');
  if (Array.isArray(content)) {
    const visible = Math.min(content.length, 32);
    for (let index = 0; index < visible; index += 1) {
      const block = content[index];
      const blockObject = context.objectOf(block);
      const type = context.valueLabel(context.own(blockObject ?? {}, 'type'))?.toLowerCase() ?? 'content';
      const name = context.valueLabel(context.own(blockObject ?? {}, 'name'));
      const title = type === 'toolcall'
        ? (name ? 'Tool call · ' + name : 'Tool call')
        : content.length === 1
          ? (type === 'text' ? 'Message' : type.replaceAll('_', ' '))
          : type.replaceAll('_', ' ') + ' ' + String(index + 1);
      context.appendAgentContentBlock(sections, block, title, role);
    }
    if (content.length > visible) {
      sections.push({
        title: 'Additional content blocks',
        code: JSON.stringify({ omittedBlocks: content.length - visible }, null, 2),
        truncated: true,
        previewOnly: true,
        language: 'json',
      });
    }
  } else if (typeof content === 'string' && content.length > 0) {
    context.addTextCandidate(sections, role === 'system' ? 'System message' : 'Message', content, role === 'assistant');
  }

  if (role === 'bashexecution') {
    context.addCodeCandidate(sections, 'Command', context.own(message, 'command'), 'shell');
    context.addOutputCandidate(sections, 'Output', context.own(message, 'output'));
    context.addCodeCandidate(sections, 'Execution details', message, 'json');
  } else if (role === 'custom') {
    context.addTextCandidate(sections, 'Custom message', context.own(message, 'content'), false);
    context.addCodeCandidate(sections, 'Custom details', context.own(message, 'details'), 'json');
  } else if (role === 'branchsummary' || role === 'compactionsummary') {
    context.addTextCandidate(sections, role === 'branchsummary' ? 'Branch summary' : 'Compaction summary', context.own(message, 'summary'), true);
    context.addCodeCandidate(sections, 'Summary details', context.own(message, 'details'), 'json');
  }

  const namedSections = context.objectOf(context.own(message, 'sections'));
  if (namedSections) {
    let count = 0;
    for (const key of Object.keys(namedSections)) {
      if (count >= 32) break;
      const value = context.own(namedSections, key);
      if (value === null) {
        context.addCodeCandidate(sections, 'System section · ' + key, null, 'json');
      } else {
        context.addTextCandidate(sections, 'System section · ' + key, value, true);
      }
      count += 1;
    }
  }

  const toolsAdded = context.own(message, 'toolsAdded');
  if (Array.isArray(toolsAdded)) {
    const visible = Math.min(toolsAdded.length, 32);
    for (let index = 0; index < visible; index += 1) {
      const tool = context.objectOf(toolsAdded[index]);
      if (!tool) continue;
      const name = context.valueLabel(context.own(tool, 'name')) ?? String(index + 1);
      context.addTextCandidate(sections, 'Tool declaration · ' + name, context.own(tool, 'description'));
      context.addCodeCandidate(sections, 'Tool schema · ' + name, context.own(tool, 'parameters'), 'json');
    }
    if (toolsAdded.length > visible) {
      sections.push({
        title: 'Additional tool declarations',
        code: JSON.stringify({ omittedTools: toolsAdded.length - visible }, null, 2),
        truncated: true,
        previewOnly: true,
        language: 'json',
      });
    }
  }

  const toolsRemoved = context.own(message, 'toolsRemoved');
  if (Array.isArray(toolsRemoved)) {
    const names = toolsRemoved
      .slice(0, 32)
      .map((item) => context.valueLabel(context.own(context.objectOf(item) ?? {}, 'name')) ?? context.valueLabel(item))
      .filter((name): name is string => Boolean(name));
    if (names.length > 0) context.addTextCandidate(sections, 'Tools removed', names.join(', '));
  }

  if (role === 'toolresult') addPiToolDetailDiffs(context, sections, context.own(message, 'details'));
  context.addCodeCandidate(sections, 'Tool details', context.own(message, 'details'), 'json');
  context.addCodeCandidate(sections, 'Nested tool calls', context.own(message, 'nestedCalls'), 'json');
  return sections;
}

/** Provider-only projection; raw records and rendering budgets remain in the facade. */
export function buildPiEventSections(
  payload: PiEventObject,
  profile: AgentRowProjection | undefined,
  context: PiEventBuilderContext,
): EventPresentationSection[] {
  if (profile?.profileId !== 'pi-coding-agent') return [];
  if (context.valueLabel(context.own(payload, 'type'))?.toLowerCase() === 'custom_message') {
    return piCustomMessageSections(context, payload);
  }
  return piMessageSections(context, payload);
}
