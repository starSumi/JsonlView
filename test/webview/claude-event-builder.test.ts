import { describe, expect, it } from 'vitest';
import type { AgentRowProjection } from '../../src/shared/types';
import { buildClaudeEventSections, type ClaudeEventBuilderContext } from '../../src/webview/providers/claude-event-builder';
import type { EventPresentationSection } from '../../src/webview/features/event-presentation/model';

function context(): ClaudeEventBuilderContext {
  const objectOf = (value: unknown): Record<string, unknown> | undefined => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  );
  const own = (object: Record<string, unknown>, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined;
  const textOf = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    const object = objectOf(value);
    if (object) return ['text', 'content', 'description', 'systemPrompt'].map((key) => own(object, key)).find((candidate): candidate is string => typeof candidate === 'string');
    return undefined;
  };
  const textSection = (value: unknown) => {
    const text = textOf(value);
    return text === undefined ? {} : { text, fullText: text, truncated: false, previewOnly: false };
  };
  const codeSectionValue = (value: unknown) => {
    const code = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return code === undefined ? undefined : { code, fullCode: code, truncated: false, previewOnly: false };
  };
  const valueLabel = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  const addTextCandidate = (sections: EventPresentationSection[], title: string, value: unknown, richText = false): void => {
    const content = textSection(value);
    if (content.text !== undefined && !sections.some((section) => section.title === title)) sections.push({ title, ...content, richText });
  };
  const addCodeCandidate = (sections: EventPresentationSection[], title: string, value: unknown, language?: string): void => {
    const rendered = codeSectionValue(value);
    if (rendered && !sections.some((section) => section.title === title)) sections.push({ title, ...rendered, ...(language ? { language } : {}) });
  };
  const addTextDiffCandidate = (sections: EventPresentationSection[], title: string, value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    sections.push({ title, code: value, fullText: value, language: 'diff' });
    return true;
  };
  const appendAgentContentBlock = (sections: EventPresentationSection[], block: unknown, title: string, role?: string): void => {
    const object = objectOf(block);
    if (typeof block === 'string') addTextCandidate(sections, title, block, role === 'assistant');
    else if (object?.type === 'text') addTextCandidate(sections, title, own(object, 'text'), role === 'assistant');
    else addCodeCandidate(sections, title, block, 'json');
  };
  return { objectOf, own, valueLabel, textOf, textSection, codeSectionValue, addTextCandidate, addCodeCandidate, addTextDiffCandidate, appendAgentContentBlock };
}

const profile: AgentRowProjection = {
  profileId: 'claude-code-session',
  eventKind: 'checkpoint',
  summary: 'Claude checkpoint',
  evidence: [],
  confidence: 'source',
};

describe('buildClaudeEventSections', () => {
  it('keeps Claude attachment prompt, tool descriptions, and rendered content in order', () => {
    const sections = buildClaudeEventSections({
      type: 'attachment',
      attachment: {
        type: 'prompt_snapshot',
        systemPrompt: 'System guidance',
        tools: [{ name: 'Read', description: 'Read a file safely' }],
        addedBlocks: 'Injected block',
        rendered: [{ content: 'Rendered prompt content' }],
      },
    }, profile, context());

    expect(sections.map((section) => section.title)).toEqual([
      'System prompt',
      'Tool description · Read',
      'Added blocks',
      'Rendered content',
    ]);
    expect(sections[0]?.text).toContain('System guidance');
    expect(sections[1]?.text).toBe('Read a file safely');
  });

  it('projects nested memory content and raw content without exposing the source shape as JSON', () => {
    const sections = buildClaudeEventSections({
      type: 'attachment',
      attachment: {
        type: 'nested_memory',
        content: {
          type: 'User',
          content: '# Redacted memory',
          rawContent: '---\npaths: [redacted]\n---',
        },
      },
    }, profile, context());

    expect(sections.map((section) => section.title)).toEqual(['Attachment content', 'Raw content']);
    expect(sections[0]?.text).toContain('# Redacted memory');
    expect(sections[1]?.text).toContain('paths: [redacted]');
  });

  it('renders a Write tool input when no tool result wrapper exists', () => {
    const sections = buildClaudeEventSections({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '<redacted>/README.md', content: '# Example\n\nBounded content.' },
        }],
      },
    }, profile, context());

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: 'Proposed file content' });
    expect(sections[0]?.code).toContain('# Example');
  });

  it('returns no provider projection for other profiles', () => {
    expect(buildClaudeEventSections({ type: 'attachment', attachment: { text: 'opaque' } }, { ...profile, profileId: 'pi-coding-agent' }, context())).toEqual([]);
  });
});
