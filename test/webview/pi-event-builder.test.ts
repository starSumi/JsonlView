import { describe, expect, it } from 'vitest';
import {
  buildPiEventSections,
  type PiEventBuilderContext,
  type PiEventObject,
} from '../../src/webview/providers/pi-event-builder';
import type { EventPresentationSection } from '../../src/webview/features/event-presentation/model';

const piProfile = { profileId: 'pi-coding-agent' } as never;

function context(): PiEventBuilderContext {
  const objectOf = (value: unknown): PiEventObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as PiEventObject
    : undefined;
  const own = (object: PiEventObject, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined;
  const valueLabel = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  const addTextCandidate = (sections: EventPresentationSection[], title: string, value: unknown, richText = false): void => {
    if (value === undefined || sections.some((section) => section.title === title)) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text) sections.push({ title, text, fullText: text, richText });
  };
  const addCodeCandidate = (sections: EventPresentationSection[], title: string, value: unknown, language?: string): void => {
    if (value === undefined || sections.some((section) => section.title === title)) return;
    sections.push({ title, code: typeof value === 'string' ? value : JSON.stringify(value), ...(language ? { language } : {}) });
  };
  const addTextDiffCandidate = (sections: EventPresentationSection[], title: string, value: unknown, alreadyTruncated = false): boolean => {
    if (typeof value !== 'string' || value.length === 0 || sections.some((section) => section.title === title)) return false;
    sections.push({ title, code: value.slice(0, 40), language: 'diff', truncated: alreadyTruncated || value.length > 40, previewOnly: alreadyTruncated || value.length > 40 });
    return true;
  };
  const addDiffCandidate = (sections: EventPresentationSection[], title: string, value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    return addTextDiffCandidate(sections, title, value);
  };
  return {
    objectOf,
    own,
    valueLabel,
    addTextCandidate,
    addOutputCandidate: addTextCandidate,
    addCodeCandidate,
    addTextDiffCandidate,
    addDiffCandidate,
    appendAgentContentBlock: (sections, block, title, role) => {
      const object = objectOf(block);
      const type = valueLabel(own(object ?? {}, 'type'))?.toLowerCase();
      if (typeof block === 'string') {
        addTextCandidate(sections, title, block, role === 'assistant');
      } else if (type === 'text' || type === 'thinking') {
        addTextCandidate(sections, title, own(object ?? {}, 'text') ?? own(object ?? {}, 'thinking'), role === 'assistant' && type === 'text');
      } else {
        addCodeCandidate(sections, title, block, 'json');
      }
    },
  };
}

describe('Pi event builder', () => {
  it('projects tool declarations, named sections, nested calls, and content blocks', () => {
    const sections = buildPiEventSections({
      type: 'message',
      message: {
        role: 'system',
        content: [{ type: 'text', text: 'system guidance' }],
        sections: { preamble: 'preamble text', context: null },
        toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
        toolsRemoved: [{ name: 'old_tool' }],
        nestedCalls: [{ id: 'nested-1', name: 'read' }],
      },
    }, piProfile, context());

    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Message', text: 'system guidance' }),
      expect.objectContaining({ title: 'System section · preamble', text: 'preamble text' }),
      expect.objectContaining({ title: 'System section · context', language: 'json' }),
      expect.objectContaining({ title: 'Tool declaration · read', text: 'Read a file' }),
      expect.objectContaining({ title: 'Tool schema · read', language: 'json' }),
      expect.objectContaining({ title: 'Tools removed', text: 'old_tool' }),
      expect.objectContaining({ title: 'Nested tool calls', language: 'json' }),
    ]));
  });

  it('renders Pi tool-result diff and patch details without flattening the source', () => {
    const sections = buildPiEventSections({
      type: 'message',
      message: {
        role: 'toolResult',
        details: {
          diff: '--- a/demo.ts\n+++ b/demo.ts',
          patch: { before: 'old', after: 'new' },
        },
        content: [{ type: 'text', text: 'updated' }],
      },
    }, piProfile, context());

    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Details diff', language: 'diff' }),
      expect.objectContaining({ title: 'Details patch', language: 'json' }),
      expect.objectContaining({ title: 'Tool details', language: 'json' }),
    ]));
  });

  it('covers custom, execution, branch, and compaction messages', () => {
    expect(buildPiEventSections({ type: 'custom_message', customType: 'notice', display: true, content: [{ type: 'text', text: 'hello' }] }, piProfile, context()).map((section) => section.title)).toEqual(['Custom type', 'Display', 'Custom message']);
    expect(buildPiEventSections({ type: 'message', message: { role: 'bashExecution', command: 'pnpm test', output: 'passed' } }, piProfile, context()).map((section) => section.title)).toEqual(['Command', 'Output', 'Execution details']);
    expect(buildPiEventSections({ type: 'message', message: { role: 'branchSummary', summary: 'branch complete', details: { count: 2 } } }, piProfile, context()).map((section) => section.title)).toEqual(['Branch summary', 'Summary details', 'Tool details']);
    expect(buildPiEventSections({ type: 'message', message: { role: 'compactionSummary', summary: 'compacted' } }, piProfile, context()).map((section) => section.title)).toEqual(['Compaction summary']);
  });

  it('bounds unknown input, preserves over-limit markers, and rejects non-Pi profiles', () => {
    const manyTools = Array.from({ length: 40 }, (_, index) => ({ name: `tool-${index}`, description: 'desc' }));
    const sections = buildPiEventSections({ type: 'message', message: { role: 'assistant', toolsAdded: manyTools, content: Array.from({ length: 40 }, () => ({ type: 'unknown', value: true })) } }, piProfile, context());
    expect(sections).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Additional tool declarations', truncated: true }), expect.objectContaining({ title: 'Additional content blocks', truncated: true })]));
    expect(buildPiEventSections({ type: 'message', message: { role: 'assistant', content: [{ type: 'unknown', value: true }] } }, piProfile, context())).toEqual([expect.objectContaining({ title: 'unknown', language: 'json' })]);
    expect(buildPiEventSections({ type: 'message', message: { role: 'assistant', content: 'ignored' } }, { profileId: 'codex-rollout' } as never, context())).toEqual([]);
    expect(buildPiEventSections({ type: 'message' }, piProfile, context())).toEqual([]);
  });
});
