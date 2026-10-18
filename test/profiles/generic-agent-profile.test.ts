import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry } from '../../src/profiles/profile-registry';

const context = { generation: 'generic-test' };

describe('bounded generic agent event adapter', () => {
  it('detects nested provider-neutral envelopes and preserves evidence paths', () => {
    const registry = new AgentProfileRegistry();
    const decision = registry.detect([
      { value: { type: 'agent.message.appended', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], messageId: 'm1' }, sessionId: 's1' } } },
      { value: { event: 'interaction.request', request: { toolName: 'read_file', toolCallId: 'c1', action: { path: 'notes.txt' } }, session_id: 's1' } },
    ]);
    expect(decision.selectedProfileId).toBe('generic-agent-events');
    const row = registry.project('generic-agent-events', { value: { type: 'agent.message.appended', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], messageId: 'm1' }, sessionId: 's1' } } }, context);
    expect(row).toMatchObject({ eventKind: 'message', actor: 'assistant', sessionId: 's1', messageId: 'm1' });
    expect(row.evidence).toEqual(expect.arrayContaining([
      { field: 'eventKind', path: { tokens: [{ kind: 'key', value: 'type' }] } },
      { field: 'sessionId', path: { tokens: [{ kind: 'key', value: 'payload' }, { kind: 'key', value: 'sessionId' }] } },
    ]));
  });

  it('normalizes tool aliases, numeric timestamps and usage without pairing rows', () => {
    const registry = new AgentProfileRegistry();
    const row = registry.project('generic-agent-events', { value: {
      event_type: 'tool.result',
      data: { toolCallId: 'call-1', toolName: 'shell', output: [{ type: 'text', text: 'done' }], isError: true },
      timestamp: 1_700_000_000,
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    } }, context);
    expect(row).toMatchObject({ eventKind: 'tool_result', toolCallId: 'call-1', timestamp: '2023-11-14T22:13:20.000Z', usage: { input: 3, output: 5, total: 8 } });
    expect(row.derivedFields).toMatchObject({ toolName: 'shell', toolError: true });
  });

  it('keeps unknown and prototype-looking event names as other', () => {
    const registry = new AgentProfileRegistry();
    for (const event of ['future_event', '__proto__']) {
      const row = registry.project('generic-agent-events', { value: { event, content: 'literal data' } }, context);
      expect(row.eventKind).toBe('other');
      expect(row.summary).toContain(event);
    }
  });

  it('bounds content blocks and marks the projection as truncated', () => {
    const registry = new AgentProfileRegistry();
    const row = registry.project('generic-agent-events', { value: { event: 'message', content: Array.from({ length: 40 }, (_, index) => ({ type: 'text', text: `part-${index}` })) } }, context);
    expect(row.eventKind).toBe('message');
    expect(row.derivedFields?.contentTruncated).toBe(true);
    expect(String(row.derivedFields?.content).length).toBeLessThanOrEqual(240);
  });
});
