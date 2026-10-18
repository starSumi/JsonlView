import { describe, expect, it } from 'vitest';
import { buildKimiEventSections, type KimiEventBuilderContext, type KimiEventObject } from '../../src/webview/providers/kimi-event-builder';
import type { EventPresentationSection } from '../../src/webview/features/event-presentation/model';

const kimiProfile = { profileId: 'kimi-code-session' } as never;

function context(): KimiEventBuilderContext {
  const objectOf = (value: unknown): KimiEventObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as KimiEventObject
    : undefined;
  const own = (object: KimiEventObject, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined;
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
  return { objectOf, own, valueLabel, addTextCandidate, addCodeCandidate };
}

describe('Kimi event builder', () => {
  it('preserves opaque reasoning flags and unknown structured parts without leaking hidden content', () => {
    const sections = buildKimiEventSections({ type: 'context.append_message', message: { role: 'assistant', content: [
      { type: 'think', think: 'visible reasoning' },
      { type: 'think', think: 'secret', hidden: true },
      { type: 'think', think: 'ciphertext', encrypted: 'opaque' },
      { type: 'image_url', imageUrl: { url: 'https://example.invalid/source.png' } },
    ] } }, kimiProfile, context());

    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Reasoning', text: 'visible reasoning' }),
      expect.objectContaining({ title: 'Opaque reasoning · source flag', code: expect.stringContaining('opaque') }),
      expect.objectContaining({ title: 'Message 4 · reference or structured content', code: expect.stringContaining('source.png') }),
    ]));
    expect(JSON.stringify(sections)).not.toMatch(/secret|ciphertext/);
  });

  it('limits content and tool-call projection and marks omitted records for Raw inspection', () => {
    const content: unknown[] = Array.from({ length: 33 }, (_, index) => ({ type: 'text', text: `part-${index}` }));
    Object.defineProperty(content, 32, { get() { throw new Error('content budget exceeded'); } });
    const calls: unknown[] = Array.from({ length: 33 }, (_, index) => ({ name: `tool-${index}`, arguments: { index } }));
    Object.defineProperty(calls, 32, { get() { throw new Error('call budget exceeded'); } });

    const sections = buildKimiEventSections({
      type: 'context.append_message',
      message: { role: 'user', content, toolCalls: calls },
    }, kimiProfile, context());

    expect(sections.filter((section) => /^Message \d+$/.test(section.title))).toHaveLength(32);
    expect(sections.filter((section) => /^Tool call \d+ · tool-/.test(section.title))).toHaveLength(32);
    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Additional content · available in Raw', truncated: true, previewOnly: true }),
      expect.objectContaining({ title: 'Additional tool calls · available in Raw', truncated: true, previewOnly: true }),
    ]));
  });

  it('does not project Kimi sections for a different provider profile', () => {
    expect(buildKimiEventSections({ type: 'context.append_message', message: { content: 'text' } }, { profileId: 'generic' } as never, context())).toEqual([]);
  });
});
