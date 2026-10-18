import { describe, expect, it } from 'vitest';
import type { AgentRowProjection } from '../../src/shared/types';
import { buildAgentEventPresentation } from '../../src/webview/event-presentation';

const generic: AgentRowProjection = { profileId: 'generic', eventKind: 'other', summary: 'dataset', evidence: [], confidence: 'source' };
const kimi: AgentRowProjection = { profileId: 'kimi-code-session', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source' };

describe('dataset scene detail presentation', () => {
  it('labels a dataset, displays response aliases once and retains top-level source authority', () => {
    const model = buildAgentEventPresentation({
      prompt: 'question', response: 'answer', title: 'A title', tags: ['tag'],
      payload: { prompt: 'nested prompt', response: 'nested answer' },
    }, generic);
    expect(model?.title).toBe('Dataset · prompt');
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Prompt', text: 'question' }),
      expect.objectContaining({ title: 'Response', text: 'answer' }),
      expect.objectContaining({ title: 'Title', text: 'A title' }),
      expect.objectContaining({ title: 'Tags', code: expect.stringContaining('tag') }),
    ]));
    expect(model?.sections.filter((section) => section.title === 'Response')).toHaveLength(1);
    expect(JSON.stringify(model)).not.toContain('nested answer');
  });

  it('presents tokenized columns and source declared counts without tokenizer claims', () => {
    const model = buildAgentEventPresentation({ input_ids: [1, 2], labels: [-100, 2], attention_mask: [1, 1], num_tokens: 3 }, generic);
    expect(model?.title).toBe('Dataset · tokenized');
    expect(model?.metadata).toContainEqual({ label: 'token count basis', value: 'declared by source' });
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Input IDs', code: expect.stringContaining('1') }),
      expect.objectContaining({ title: 'Labels', code: expect.stringContaining('-100') }),
      expect.objectContaining({ title: 'Attention mask' }),
      expect.objectContaining({ title: 'Declared num tokens', text: '3' }),
    ]));
  });

  it('retains explicit loss weights and renders media as inert source references', () => {
    const model = buildAgentEventPresentation({ messages: [
      { role: 'user', content: 'question', loss_weight: 0 },
      { role: 'assistant', content: 'answer', loss_weight: [0, 1] },
      { role: 'assistant', content: [{ type: 'image_url', image_url: 'https://example.invalid/other.png' }], loss_weight: 1 },
    ], images: ['https://example.invalid/image.png'] }, generic);
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Message 1 · user · declared loss weight', code: '0' }),
      expect.objectContaining({ title: 'Message 2 · assistant · declared loss weight', code: expect.stringContaining('1') }),
      expect.objectContaining({ title: 'Message 3 · assistant · declared loss weight', code: '1' }),
      expect.objectContaining({ title: 'Message 3 · assistant · structured content', code: expect.stringContaining('other.png') }),
      expect.objectContaining({ title: 'Images · references only', code: expect.stringContaining('https://example.invalid/image.png') }),
    ]));
  });
});

describe('Kimi persisted record presentation', () => {
  it('renders profile binding systemPrompt strings as a dedicated text section', () => {
    const model = buildAgentEventPresentation({
      type: 'profile.bind',
      systemPrompt: 'You are Kimi Code CLI, an interactive general AI agent.',
    }, kimi);

    expect(model?.sections).toEqual([expect.objectContaining({
      title: 'System prompt',
      text: 'You are Kimi Code CLI, an interactive general AI agent.',
    })]);
  });

  it('renders typed snapshots, commands, results, tasks, and steered content in detail', () => {
    const snapshot = buildAgentEventPresentation({
      type: 'llm.tools_snapshot',
      tools: [{ name: 'Lookup', description: 'Look up a short value.', parameters: { type: 'object' } }],
    }, kimi);
    expect(snapshot?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tool description · Lookup', text: 'Look up a short value.' }),
      expect.objectContaining({ title: 'Tool parameters · Lookup', code: expect.stringContaining('object') }),
    ]));

    const command = buildAgentEventPresentation({
      type: 'context.append_loop_event',
      event: { type: 'tool.call', name: 'Bash', command: 'Get-ChildItem' },
    }, kimi);
    expect(command?.sections).toEqual([expect.objectContaining({ title: 'Tool command · Bash', code: 'Get-ChildItem', language: 'shell' })]);

    const result = buildAgentEventPresentation({
      type: 'context.append_loop_event',
      event: { type: 'tool.result', result: { output: [{ type: 'text', text: 'done' }], note: 'completed' } },
    }, kimi);
    expect(result?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tool result 1', text: 'done' }),
      expect.objectContaining({ title: 'Result note', text: 'completed' }),
    ]));

    const task = buildAgentEventPresentation({ type: 'task.started', info: { description: 'Index the workspace' } }, kimi);
    expect(task?.sections).toEqual([expect.objectContaining({ title: 'Task description', text: 'Index the workspace' })]);

    const steered = buildAgentEventPresentation({ type: 'prompt.steered', content: [{ type: 'text', text: 'Use the focused file.' }] }, kimi);
    expect(steered?.sections).toEqual([expect.objectContaining({ title: 'Prompt 1', text: 'Use the focused file.' })]);
  });

  it('unwraps message text and reasoning while keeping opaque parts private to Raw', () => {
    const model = buildAgentEventPresentation({ type: 'context.append_message', message: { role: 'assistant', content: [
      { type: 'think', think: 'Visible reasoning' },
      { type: 'think', think: 'HIDDEN_PAYLOAD', hidden: true },
      { type: 'think', think: 'ENCRYPTED_PAYLOAD', encrypted: 'opaque' },
      { type: 'text', text: '## Answer' },
      { type: 'image_url', imageUrl: { url: 'https://example.invalid/image.png' } },
    ], toolCalls: [{ type: 'function', name: 'Bash', arguments: '{"command":"echo hello"}' }] } }, kimi);
    expect(model?.title).toBe('Kimi · context.append message');
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Reasoning', text: 'Visible reasoning' }),
      expect.objectContaining({ title: 'Message 4', text: '## Answer', richText: true }),
      expect.objectContaining({ title: 'Tool call · Bash', code: expect.stringContaining('echo hello') }),
      expect.objectContaining({ title: 'Message 5 · reference or structured content', code: expect.stringContaining('image.png') }),
    ]));
    expect(JSON.stringify(model)).not.toMatch(/HIDDEN_PAYLOAD|ENCRYPTED_PAYLOAD/);
  });

  it('supports the legacy function wrapper and bounds message and call previews', () => {
    const content: unknown[] = Array.from({ length: 32 }, () => ({ type: 'text', text: 'hello' }));
    Object.defineProperty(content, 32, { get() { throw new Error('content budget exceeded'); } });
    const calls: unknown[] = Array.from({ length: 32 }, () => ({ type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }));
    Object.defineProperty(calls, 32, { get() { throw new Error('call budget exceeded'); } });
    const model = buildAgentEventPresentation({ type: 'context.append_message', message: { role: 'user', content, toolCalls: calls } }, kimi);
    expect(model?.sections.filter((section) => section.title.startsWith('Tool call ') && section.title.endsWith(' · Bash'))).toHaveLength(32);
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Additional content · available in Raw', truncated: true, previewOnly: true }),
      expect.objectContaining({ title: 'Additional tool calls · available in Raw', truncated: true, previewOnly: true }),
    ]));
  });

  it('presents nested content, tool calls and results using their actual event type', () => {
    const part = buildAgentEventPresentation({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'streamed text' } } }, kimi);
    expect(part?.title).toBe('Kimi · content.part');
    expect(part?.sections).toEqual([expect.objectContaining({ title: 'Content', text: 'streamed text', richText: true })]);
    const call = buildAgentEventPresentation({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', toolCallId: 'c1', args: { command: 'echo hello' } } }, kimi);
    expect(call?.sections).toEqual([expect.objectContaining({ title: 'Tool call · Bash', code: expect.stringContaining('echo hello') })]);
    const result = buildAgentEventPresentation({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'c1', result: { output: [{ type: 'text', text: 'Done' }], isError: true, note: 'Failed intentionally' } } }, kimi);
    expect(result?.metadata).toEqual(expect.arrayContaining([{ label: 'tool call id', value: 'c1' }, { label: 'error', value: 'true' }]));
    expect(result?.sections).toEqual([expect.objectContaining({ title: 'Tool result 1', text: 'Done' }), expect.objectContaining({ title: 'Result note', text: 'Failed intentionally' })]);
  });

  it('keeps unknown and lifecycle records inspectable without replaying history', () => {
    const model = buildAgentEventPresentation({ type: 'context.clear', reason: 'reset', checkpoint: { opaque: true } }, kimi);
    expect(model?.title).toBe('Kimi · context.clear');
    expect(model?.sections).toEqual([expect.objectContaining({ title: 'Payload', code: expect.stringContaining('checkpoint') })]);
  });
});
