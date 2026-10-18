import { describe, expect, it } from 'vitest';
import { buildAgentEventPresentation } from '../../src/webview/event-presentation';

const profile = {
  profileId: 'generic-agent-events',
  eventKind: 'message',
  summary: 'generic event',
  evidence: [],
  confidence: 'source',
} as never;

describe('generic agent event presentation', () => {
  it('projects nested message content blocks and preserves media as a bounded reference', () => {
    const model = buildAgentEventPresentation({
      type: 'agent.message.appended',
      payload: {
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'answer' },
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } },
          ],
        },
      },
    }, profile);

    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'text 1', text: 'answer' }),
      expect.objectContaining({ title: 'thinking 2', text: 'reasoning' }),
      expect.objectContaining({ title: 'image url 3', code: expect.stringContaining('image.png') }),
    ]));
  });

  it('projects tool calls and results from provider-neutral aliases', () => {
    const model = buildAgentEventPresentation({
      event: 'agent.tool.result',
      data: {
        toolCall: { name: 'search', arguments: { query: 'jsonl' } },
        toolResult: { content: [{ type: 'text', text: 'one result' }] },
      },
    }, {
      profileId: 'generic-agent-events',
      eventKind: 'tool_result',
      summary: 'tool result',
      evidence: [],
      confidence: 'source',
    } as never);

    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tool call · search', code: expect.stringContaining('jsonl') }),
      expect.objectContaining({ title: 'Tool result', text: 'one result' }),
    ]));
  });

  it('limits content blocks and leaves unknown payloads to Raw', () => {
    const content = Array.from({ length: 40 }, (_, index) => ({ type: 'text', text: `part-${index}` }));
    const model = buildAgentEventPresentation({
      type: 'agent.message.appended',
      payload: { message: { role: 'assistant', content }, unknown: { keep: true } },
    }, profile);

    expect(model?.sections.filter((section) => /^text \d+$/.test(section.title))).toHaveLength(32);
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Additional content · available in Raw', truncated: true, previewOnly: true }),
    ]));
  });
});
