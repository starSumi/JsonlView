import { describe, expect, it } from 'vitest';
import type { AgentRowProjection } from '../../src/shared/types';
import { MAX_CONVERSATION_CHARACTERS, MAX_CONVERSATION_DEPTH, MAX_CONVERSATION_PARTS,
  projectConversation } from '../../src/profiles/conversation-projection';

describe('bounded conversation source projection', () => {
  it.each([
    ['codex-rollout', { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Actual answer' }] } }],
    ['codex-exec-jsonl', { type: 'item.completed', item: { type: 'agent_message', text: 'Actual answer' } }],
    ['codex-history', { session_id: 'synthetic', text: 'Actual answer' }],
    ['claude-code-session', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Actual answer' }] } }],
    ['pi-coding-agent', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Actual answer' }] } }],
    ['generic-agent-events', { actor: 'assistant', message: 'Actual answer' }],
    ['opentelemetry', { body: 'Actual answer' }],
    ['software-engineering-agent', { message: 'Actual answer' }],
    ['structured-application-log', { message: 'Actual answer', level: 'info' }],
    ['generic', { prompt: 'Actual answer' }],
  ])('retains actual text through %s envelopes', (profileId, value) => {
    const profile = { profileId, eventKind: 'message', actor: 'assistant', summary: 'Lossy summary' } as AgentRowProjection;
    const projection = projectConversation(value, profile);
    expect(projection.parts[0]?.text).toBe('Actual answer');
    expect(projection.parts[0]?.path.tokens.length).toBeGreaterThan(0);
    expect(projection.truncated).toBe(false);
  });

  it.each(['codex-trace', 'codex-session-index'])('keeps %s metadata neutral without fabricating content', (profileId) => {
    const profile = { profileId, eventKind: 'session', summary: 'Metadata' } as AgentRowProjection;
    expect(projectConversation({ id: 'synthetic', metadata: { text: 'Not a message' } }, profile))
      .toEqual({ parts: [], truncated: false });
  });

  it('supports latest Kimi append messages, loop content parts and tool outputs', () => {
    expect(projectConversation({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } }).parts)
      .toMatchObject([{ role: 'user', text: 'Hello', path: { tokens: [{ kind: 'key', value: 'message' }, { kind: 'key', value: 'content' }, { kind: 'index', value: 0 }, { kind: 'key', value: 'text' }] } }]);
    expect(projectConversation({ type: 'append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'Considering' } } }).parts)
      .toMatchObject([{ role: 'reasoning', text: 'Considering' }]);
    const profile = { profileId: 'kimi', eventKind: 'tool_result', actor: 'tool', summary: 'Result' } as AgentRowProjection;
    expect(projectConversation({ event: { type: 'tool.result', result: { output: 'Done', isError: false } } }, profile).parts)
      .toMatchObject([{ role: 'tool', text: 'Done', label: 'Tool result' }]);
  });

  it('preserves dataset roles, branch labels and structural paths', () => {
    expect(projectConversation({ instruction: 'Do this', input: 'Context', chosen: 'Yes', rejected: 'No' }).parts)
      .toMatchObject([{ role: 'user', label: 'Instruction' }, { role: 'user', label: 'Input' },
        { role: 'assistant', label: 'Chosen', path: { tokens: [{ kind: 'key', value: 'chosen' }] } },
        { role: 'assistant', label: 'Rejected' }]);
  });

  it('keeps unfamiliar roles neutral including inherited object property names', () => {
    for (const role of ['unknown', '__proto__', 'constructor', 'toString']) {
      expect(projectConversation({ role, content: 'Unfamiliar message' }).parts)
        .toMatchObject([{ role, text: 'Unfamiliar message' }]);
    }
    expect(projectConversation({ content: [{ type: 'thinking', thinking: 'Consider this' }] }).parts)
      .toMatchObject([{ role: 'reasoning', text: 'Consider this' }]);
  });

  it('caps aggregate text, leaves valid surrogate pairs intact and replaces malformed Unicode', () => {
    const capped = projectConversation({ text: 'x'.repeat(MAX_CONVERSATION_CHARACTERS - 1) + '😀more' });
    expect(capped.parts[0]?.text).toHaveLength(MAX_CONVERSATION_CHARACTERS - 1);
    expect(capped.parts[0]?.text.endsWith('\uD83D')).toBe(false);
    expect(capped.truncated).toBe(true);
    expect(projectConversation({ text: '\uD800a\uDC00😀' }).parts[0]?.text).toBe('�a�😀');
    const multipart = projectConversation({ messages: [{ content: 'a'.repeat(1600) }, { content: 'b'.repeat(1600) }] });
    expect(multipart.parts.reduce((total, part) => total + part.text.length, 0)).toBe(MAX_CONVERSATION_CHARACTERS);
    expect(multipart.truncated).toBe(true);
  });

  it('reports omitted parts, depth and source media without traversing arbitrary metadata', () => {
    const projection = projectConversation({ content: Array.from({ length: 1000 }, () => ({ text: 'x' })) });
    expect(projection.parts).toHaveLength(MAX_CONVERSATION_PARTS);
    expect(projection.truncated).toBe(true);
    let deep: unknown = { text: 'Hidden' };
    for (let index = 0; index < MAX_CONVERSATION_DEPTH + 1; index++) deep = { payload: deep };
    expect(projectConversation(deep)).toEqual({ parts: [], truncated: true });
    expect(projectConversation({ content: [{ type: 'image_url', text: 'Do not load' }, { type: 'text', text: 'Visible' }] }))
      .toMatchObject({ parts: [{ text: 'Visible' }], truncated: true });
    expect(projectConversation({ metadata: { message: 'Hidden' } })).toEqual({ parts: [], truncated: false });
    expect(projectConversation(undefined)).toEqual({ parts: [], truncated: false });
  });
});
