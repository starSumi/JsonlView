import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry, correlationStateKey } from '../../src/profiles';
import { claudeFixture, genericAgentFixture } from './fixtures';

describe('Agent correlation', () => {
  it('correlates only explicit turn, tool and parent IDs while conserving records', () => {
    const registry = new AgentProfileRegistry();
    const projections = genericAgentFixture.map((value) => registry.project('generic-agent-events', { value }, { generation: 'g1' }));
    const inputs = projections.map((projection, index) => ({ recordKey: String(index + 1), projection }));
    const result = registry.correlate('generic-agent-events', 'g1', inputs);

    expect(result.records).toEqual(inputs);
    expect(result.records).toHaveLength(genericAgentFixture.length);
    expect(result.relations.some((relation) => relation.kind === 'tool_pair' && relation.stableId === 'tool-generic')).toBe(true);
    expect(result.relations.filter((relation) => relation.kind === 'turn_member')).toHaveLength(genericAgentFixture.length - 1);
    expect(result.relations.every((relation) => relation.confidence === 'correlated')).toBe(true);
    expect(result.relations.every((relation) => relation.evidence.length > 0)).toBe(true);
  });

  it('resolves out-of-order Claude parent/child and tool pairs from stable IDs', () => {
    const registry = new AgentProfileRegistry();
    const order = [2, 1, 0] as const;
    const inputs = order.map((fixtureIndex) => ({
      recordKey: String(fixtureIndex + 1),
      projection: registry.project('claude-code-session', { value: claudeFixture[fixtureIndex] }, { generation: 'g1' }),
    }));
    const result = registry.correlate('claude-code-session', 'g1', inputs);

    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_pair', stableId: 'tool-redacted' }),
      expect.objectContaining({ kind: 'parent_child', stableId: 'message-user-redacted' }),
      expect.objectContaining({ kind: 'parent_child', stableId: 'message-call-redacted' }),
    ]));
  });

  it('isolates correlation state by profile version and generation', () => {
    const registry = new AgentProfileRegistry();
    const projection = registry.project('generic-agent-events', { value: genericAgentFixture[0] }, { generation: 'g1' });
    const first = registry.correlate('generic-agent-events', 'g1', [{ recordKey: '1', projection }]);
    const second = registry.correlate('generic-agent-events', 'g2', [], first.state);

    expect(first.state.key).toBe(correlationStateKey('generic-agent-events', '1', 'g1'));
    expect(second.state.key).toBe(correlationStateKey('generic-agent-events', '1', 'g2'));
    expect(Object.keys(second.state.records)).toEqual([]);
  });

  it('returns an incremental correlation delta without repeating prior relations', () => {
    const registry = new AgentProfileRegistry();
    const call = registry.project('generic-agent-events', { value: genericAgentFixture[1] }, { generation: 'g1' });
    const result = registry.project('generic-agent-events', { value: genericAgentFixture[2] }, { generation: 'g1' });
    const first = registry.correlate('generic-agent-events', 'g1', [{ recordKey: 'call', projection: call }]);
    const second = registry.correlate('generic-agent-events', 'g1', [{ recordKey: 'result', projection: result }], first.state);
    const replay = registry.correlate('generic-agent-events', 'g1', [{ recordKey: 'result', projection: result }], second.state);

    expect(second.relations.filter((relation) => relation.kind === 'tool_pair')).toHaveLength(1);
    expect(replay.relations).toEqual([]);
  });

  it('does not invent relations for adjacent records without stable IDs', () => {
    const registry = new AgentProfileRegistry();
    const values = [
      { event: 'message', role: 'user', message: 'one' },
      { event: 'message', role: 'assistant', message: 'two' },
    ];
    const inputs = values.map((value, index) => ({
      recordKey: String(index + 1),
      projection: registry.project('generic-agent-events', { value }, { generation: 'g1' }),
    }));
    expect(registry.correlate('generic-agent-events', 'g1', inputs).relations).toEqual([]);
  });

  it('does not correlate projections produced by a different profile', () => {
    const registry = new AgentProfileRegistry();
    const projection = registry.project('generic', { value: { event: 'tool_call', tool_call_id: 'tool-redacted' } }, { generation: 'g1' });
    const result = registry.correlate('generic-agent-events', 'g1', [{ recordKey: '1', projection }]);

    expect(result.records).toEqual([{ recordKey: '1', projection }]);
    expect(result.relations).toEqual([]);
  });

  it('treats prototype-like stable IDs as data without polluting correlation dictionaries', () => {
    const registry = new AgentProfileRegistry();
    const values = [
      { event: 'tool_call', tool_call_id: '__proto__', content: 'call' },
      { event: 'tool_result', tool_call_id: '__proto__', content: 'result' },
    ];
    const inputs = values.map((value, index) => ({
      recordKey: index === 0 ? 'constructor' : '__proto__',
      projection: registry.project('generic-agent-events', { value }, { generation: 'g1' }),
    }));
    const result = registry.correlate('generic-agent-events', 'g1', inputs);

    expect(result.records).toHaveLength(2);
    expect(result.relations).toEqual([
      expect.objectContaining({ kind: 'tool_pair', stableId: '__proto__' }),
    ]);
    expect(Object.getPrototypeOf(result.state.tools)).toBeNull();
    expect(Object.getPrototypeOf(result.state.records)).toBeNull();
  });
});
