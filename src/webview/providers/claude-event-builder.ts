import type { AgentRowProjection } from '../../shared/types';
import { findSemanticFeatures } from '../../shared/semantic-features';
import { classifyContent } from '../content-analysis';
import { claudeToolSections, hasClaudeToolProjection, type ClaudeToolSection } from './claude-tool-projection';
import type { EventPresentationSection } from '../features/event-presentation/model';

export type ClaudeEventObject = Record<string, unknown>;

export interface ClaudeEventBuilderContext {
  objectOf(value: unknown): ClaudeEventObject | undefined;
  own(object: ClaudeEventObject, key: string): unknown;
  valueLabel(value: unknown): string | undefined;
  textOf(value: unknown): string | undefined;
  textSection(value: unknown): Pick<EventPresentationSection, 'text' | 'fullText' | 'truncated' | 'previewOnly'>;
  codeSectionValue(value: unknown): {
    code: string;
    fullCode?: string;
    truncated: boolean;
    previewOnly: boolean;
  } | undefined;
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
  addTextDiffCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    alreadyTruncated?: boolean,
  ): boolean;
  appendAgentContentBlock(
    sections: EventPresentationSection[],
    block: unknown,
    title: string,
    role: string | undefined,
  ): void;
}

function contentModeFor(value: string): Pick<EventPresentationSection, 'contentMode' | 'codeLanguage'> {
  const detected = classifyContent(value);
  if (detected === 'json') return { contentMode: 'json' };
  if (detected === 'markdown') return { contentMode: 'markdown' };
  return { contentMode: 'auto' };
}

function boundedTextSection(
  context: ClaudeEventBuilderContext,
  value: unknown,
  richText = false,
): Pick<EventPresentationSection, 'text' | 'fullText' | 'truncated' | 'previewOnly' | 'richText' | 'contentMode'> {
  const content = context.textSection(value);
  const source = content.fullText ?? content.text;
  return {
    ...content,
    richText,
    ...(source ? contentModeFor(source) : {}),
  };
}

function toEventPresentationSection(
  context: ClaudeEventBuilderContext,
  section: ClaudeToolSection,
): EventPresentationSection {
  if (section.kind === 'json') {
    const rendered = context.codeSectionValue(section.value);
    return {
      title: section.title,
      ...(rendered
        ? { code: rendered.code, ...(rendered.fullCode !== undefined ? { fullText: rendered.fullCode } : {}) }
        : { code: '{}' }),
      language: 'json',
      truncated: section.truncated ?? rendered?.truncated ?? false,
      previewOnly: section.truncated ?? rendered?.previewOnly ?? false,
    };
  }
  if (section.kind === 'diff') {
    const source = typeof section.value === 'string' ? section.value : JSON.stringify(section.value, null, 2);
    const added: EventPresentationSection[] = [];
    context.addTextDiffCandidate(added, section.title, source ?? '', section.truncated);
    return added[0] ?? { title: section.title, code: '', language: 'diff', truncated: true, previewOnly: true };
  }
  const text = typeof section.value === 'string' ? section.value : context.textOf(section.value);
  if (section.kind === 'code') {
    const rendered = context.codeSectionValue(text ?? section.value);
    return {
      title: section.title,
      ...(rendered
        ? { code: rendered.code, ...(rendered.fullCode !== undefined ? { fullText: rendered.fullCode } : {}) }
        : { code: '' }),
      ...(section.language ? { language: section.language } : {}),
      truncated: section.truncated ?? rendered?.truncated ?? false,
      previewOnly: section.truncated ?? rendered?.previewOnly ?? false,
    };
  }
  return {
    title: section.title,
    ...boundedTextSection(context, text ?? section.value),
    ...(section.language ? { language: section.language } : {}),
  };
}

function appendClaudeToolDescriptions(
  context: ClaudeEventBuilderContext,
  sections: EventPresentationSection[],
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  const visible = Math.min(value.length, 32);
  for (let index = 0; index < visible; index += 1) {
    const tool = context.objectOf(value[index]);
    if (!tool) continue;
    const description = context.own(tool, 'description');
    if (description === undefined) continue;
    const name = context.valueLabel(context.own(tool, 'name'));
    context.addTextCandidate(
      sections,
      name ? `Tool description · ${name}` : `Tool description · ${String(index + 1)}`,
      description,
    );
  }
  if (value.length > visible) {
    sections.push({
      title: 'Additional tool descriptions',
      code: JSON.stringify({ omittedItems: value.length - visible }, null, 2),
      truncated: true,
      previewOnly: true,
      language: 'json',
    });
  }
}

function appendRenderedClaudeContent(
  context: ClaudeEventBuilderContext,
  sections: EventPresentationSection[],
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  const visible = Math.min(value.length, 32);
  for (let index = 0; index < visible; index += 1) {
    const rendered = context.objectOf(value[index]);
    const nestedAttachment = rendered ? context.objectOf(context.own(rendered, 'attachment')) : undefined;
    const content = rendered
      ? (context.own(rendered, 'content')
        ?? context.own(rendered, 'text')
        ?? context.own(nestedAttachment ?? {}, 'text')
        ?? context.own(nestedAttachment ?? {}, 'systemPrompt'))
      : value[index];
    context.addTextCandidate(sections, visible === 1 ? 'Rendered content' : `Rendered content ${String(index + 1)}`, content);
    if (nestedAttachment) appendClaudeToolDescriptions(context, sections, context.own(nestedAttachment, 'tools'));
  }
  if (value.length > visible) {
    sections.push({
      title: 'Additional rendered content',
      code: JSON.stringify({ omittedItems: value.length - visible }, null, 2),
      truncated: true,
      previewOnly: true,
      language: 'json',
    });
  }
}

function appendClaudeToolSections(
  context: ClaudeEventBuilderContext,
  sections: EventPresentationSection[],
  payload: ClaudeEventObject,
): void {
  sections.push(...claudeToolSections(payload).map((section) => toEventPresentationSection(context, section)));
}

function appendSemanticAttachmentContent(
  context: ClaudeEventBuilderContext,
  sections: EventPresentationSection[],
  attachment: ClaudeEventObject,
): void {
  const matches = findSemanticFeatures(
    attachment,
    [
      {
        id: 'content',
        keys: ['content'],
        weight: 1.1,
        accepts: (value) => typeof value === 'string',
      },
      {
        id: 'raw-content',
        keys: ['rawContent', 'raw_content'],
        weight: 1.2,
        accepts: (value) => typeof value === 'string',
      },
    ],
    { maxDepth: 4, maxMatchesPerFeature: 4 },
  );
  const content = matches.find((match) => match.id === 'content');
  const rawContent = matches.find((match) => match.id === 'raw-content');
  if (context.own(attachment, 'text') === undefined && content) {
    context.addTextCandidate(sections, 'Attachment content', content.value, true);
  }
  if (rawContent) {
    context.addTextCandidate(sections, 'Raw content', rawContent.value, true);
  }
}

function claudeMessageSections(
  context: ClaudeEventBuilderContext,
  payload: ClaudeEventObject,
): EventPresentationSection[] {
  const message = context.objectOf(context.own(payload, 'message'));
  if (!message || !Object.hasOwn(message, 'content')) {
    const sections: EventPresentationSection[] = [];
    appendClaudeToolSections(context, sections, payload);
    return sections;
  }
  const role = context.valueLabel(context.own(message, 'role'))?.toLowerCase();
  const content = context.own(message, 'content');
  if (!Array.isArray(content)) {
    if (typeof content === 'string') {
      const sections: EventPresentationSection[] = [{
        title: 'Message',
        ...boundedTextSection(context, content, role === 'assistant'),
      }];
      appendClaudeToolSections(context, sections, payload);
      return sections;
    }
    const sections: EventPresentationSection[] = [];
    context.addCodeCandidate(sections, 'Content', content, 'json');
    appendClaudeToolSections(context, sections, payload);
    return sections;
  }
  if (content.length === 0) {
    const sections: EventPresentationSection[] = [];
    context.addCodeCandidate(sections, 'Content', content, 'json');
    appendClaudeToolSections(context, sections, payload);
    return sections;
  }
  const sections: EventPresentationSection[] = [];
  const singleTextBlock = content.length === 1 && context.objectOf(content[0])?.type === 'text';
  const visibleBlocks = Math.min(content.length, 32);
  for (let index = 0; index < visibleBlocks; index += 1) {
    const block = content[index];
    const object = context.objectOf(block);
    const type = context.valueLabel(object?.type)?.toLowerCase() ?? 'content';
    if (hasClaudeToolProjection(block)) continue;
    const title = singleTextBlock
      ? 'Message'
      : type === 'tool_result'
        ? `Tool result${content.length > 1 ? ` ${String(index + 1)}` : ''}`
        : type === 'tool_use' || type === 'server_tool_use'
          ? `Tool input${content.length > 1 ? ` ${String(index + 1)}` : ''}`
          : `${type.replaceAll('_', ' ')}${content.length > 1 ? ` ${String(index + 1)}` : ''}`;
    context.appendAgentContentBlock(sections, block, title, role);
  }
  appendClaudeToolSections(context, sections, payload);
  if (content.length > 32) {
    sections.push({ title: 'Additional content blocks', code: JSON.stringify({ omittedBlocks: content.length - 32 }, null, 2), truncated: true, previewOnly: true, language: 'json' });
  }
  return sections;
}

function claudeAttachmentSections(
  context: ClaudeEventBuilderContext,
  payload: ClaudeEventObject,
): EventPresentationSection[] {
  if (context.valueLabel(context.own(payload, 'type'))?.toLowerCase() !== 'attachment') return [];
  const sections: EventPresentationSection[] = [];
  const attachment = context.objectOf(context.own(payload, 'attachment'));
  if (attachment) {
    context.addTextCandidate(sections, 'Attachment text', context.own(attachment, 'text'));
    const attachmentType = context.valueLabel(context.own(attachment, 'type'))?.toLowerCase();
    if (attachmentType === 'nested_memory' || context.own(attachment, 'rawContent') !== undefined) {
      appendSemanticAttachmentContent(context, sections, attachment);
    }
    context.addTextCandidate(sections, 'System prompt', context.own(attachment, 'systemPrompt'), true);
    appendClaudeToolDescriptions(context, sections, context.own(attachment, 'tools'));
    context.addTextCandidate(sections, 'Added blocks', context.own(attachment, 'addedBlocks'));
    context.addTextCandidate(sections, 'Added lines', context.own(attachment, 'addedLines'));
    context.addTextCandidate(sections, 'Removed names', context.own(attachment, 'removedNames'));
    appendRenderedClaudeContent(context, sections, context.own(attachment, 'rendered'));
  }
  appendRenderedClaudeContent(context, sections, context.own(payload, 'rendered'));
  return sections;
}

/** Provider-only projection. Raw, lifecycle state, and IPC remain in the facade. */
export function buildClaudeEventSections(
  payload: ClaudeEventObject,
  profile: AgentRowProjection | undefined,
  context: ClaudeEventBuilderContext,
): EventPresentationSection[] {
  if (profile?.profileId !== 'claude-code-session') return [];
  return [
    ...claudeMessageSections(context, payload),
    ...claudeAttachmentSections(context, payload),
  ];
}
