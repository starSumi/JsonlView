import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry } from '../../src/profiles';
import { claudeFixture, codexFixture, genericAgentFixture } from './fixtures';

const context = { generation: 'generation-redacted' };

describe('Agent profile projection', () => {
  it('projects Codex messages, tools, usage, errors, subagents and unknown types', () => {
    const registry = new AgentProfileRegistry();
    const rows = codexFixture.map((value) => registry.project('codex-rollout', { value }, context));

    expect(rows.map((row) => row.eventKind)).toEqual([
      'session', 'turn', 'message', 'tool_call', 'tool_result', 'usage', 'error', 'subagent', 'other',
    ]);
    expect(rows[2]).toMatchObject({ actor: 'assistant', messageId: 'message-redacted', turnId: 'turn-redacted' });
    expect(rows[3]).toMatchObject({ toolCallId: 'call-redacted', actor: 'assistant' });
    expect(rows[4]).toMatchObject({ toolCallId: 'call-redacted', actor: 'tool' });
    expect(rows[5]?.usage).toEqual({ input: 10, output: 4, total: 14 });
    expect(rows[6]).toMatchObject({ severity: 'error' });
    expect(rows[7]).toMatchObject({ subagentId: 'child-redacted', parentId: 'parent-redacted' });
    expect(rows[8]?.summary).toContain('future_record_type');
  });

  it('projects flattened Codex message records and preserves developer roles', () => {
    const registry = new AgentProfileRegistry();
    const row = registry.project('codex-rollout', {
      value: {
        timestamp: '2026-08-31T00:00:00.000Z',
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '## Memory' }],
      },
    }, context);

    expect(row).toMatchObject({ eventKind: 'message', actor: 'developer', summary: 'developer message: ## Memory' });
    expect(row.evidence).toContainEqual({ field: 'actor', path: { tokens: [{ kind: 'key', value: 'role' }] } });
  });

  it('projects Claude messages, tool use/result, errors and unknown records independently', () => {
    const registry = new AgentProfileRegistry();
    const rows = claudeFixture.map((value) => registry.project('claude-code-session', { value }, context));

    expect(rows.map((row) => row.eventKind)).toEqual(['message', 'tool_call', 'tool_result', 'error', 'other']);
    expect(rows[0]).toMatchObject({ actor: 'user', messageId: 'message-user-redacted' });
    expect(rows[1]).toMatchObject({ toolCallId: 'tool-redacted', actor: 'assistant', model: 'model-redacted' });
    expect(rows[1]?.usage).toEqual({ input: 12, output: 3 });
    expect(rows[2]).toMatchObject({ toolCallId: 'tool-redacted', actor: 'tool' });
    expect(rows[3]).toMatchObject({ severity: 'error' });
    expect(rows[4]?.summary).toContain('future_claude_type');
  });

  it('projects current Claude control records instead of labelling them unknown', () => {
    const registry = new AgentProfileRegistry();
    const records = [
      { type: 'last-prompt', lastPrompt: 'hello', sessionId: 'session-redacted' },
      { type: 'mode', mode: 'normal', sessionId: 'session-redacted' },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'session-redacted' },
      { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['Read'] }, sessionId: 'session-redacted' },
      { type: 'queue-operation', operation: 'enqueue', content: 'queued', sessionId: 'session-redacted' },
      { type: 'atis-latch', atis: '', sessionId: 'session-redacted' },
      { type: 'ai-title', aiTitle: 'A session title', sessionId: 'session-redacted' },
      { type: 'file-history-delta', backup: 'backup.json', sessionId: 'session-redacted' },
      { type: 'progress', data: { type: 'hook_progress', command: 'pnpm test' }, sessionId: 'session-redacted' },
    ];
    const rows = records.map((value) => registry.project('claude-code-session', { value }, context));

    expect(rows.map((row) => row.eventKind)).toEqual([
      'message', 'checkpoint', 'approval', 'checkpoint', 'action', 'checkpoint', 'session', 'checkpoint', 'observation',
    ]);
    expect(rows[0]).toMatchObject({ actor: 'user', summary: 'Last prompt: hello', sessionId: 'session-redacted' });
    expect(rows[2]).toMatchObject({ actor: 'system', status: 'bypassPermissions' });
    expect(rows[3]?.derivedFields).toMatchObject({ attachmentType: 'deferred_tools_delta' });
    expect(rows[4]?.derivedFields).toMatchObject({ operation: 'enqueue' });
    expect(rows[8]).toMatchObject({ actor: 'system', summary: 'Progress: hook_progress' });
  });

  it('uses Claude leafUuid as identity for control records that have no uuid', () => {
    const registry = new AgentProfileRegistry();
    const values = [
      { type: 'last-prompt', lastPrompt: 'hello', sessionId: 'session-leaf', leafUuid: 'leaf-1' },
      { type: 'mode', mode: 'normal', sessionId: 'session-leaf', leafUuid: 'leaf-2' },
    ];
    const decision = registry.detect(values.map((value, index) => ({ value, ordinal: String(index) })));
    expect(decision.selectedProfileId).toBe('claude-code-session');
    const row = registry.project('claude-code-session', { value: values[0] }, context);
    expect(row).toMatchObject({ messageId: 'leaf-1', sessionId: 'session-leaf' });
    expect(row.evidence).toContainEqual({ field: 'messageId', path: { tokens: [{ kind: 'key', value: 'leafUuid' }] } });
  });

  it('maps only direct generic Agent fields and preserves unknown events', () => {
    const registry = new AgentProfileRegistry();
    const rows = genericAgentFixture.map((value) => registry.project('generic-agent-events', { value }, context));

    expect(rows.map((row) => row.eventKind)).toEqual(['message', 'tool_call', 'tool_result', 'usage', 'other']);
    expect(rows[0]).toMatchObject({ actor: 'user', sessionId: 'session-generic', turnId: 'turn-generic' });
    expect(rows[4]?.summary).toContain('future_event');
    expect(registry.project('generic-agent-events', { value: { event: '__proto__', content: 'literal data' } }, context).eventKind).toBe('other');
  });

  it('provides source paths for mapped fields and keeps summaries bounded and stable', () => {
    const registry = new AgentProfileRegistry();
    const record = {
      timestamp: '2026-08-30T00:00:00.000Z',
      event: 'message',
      role: 'assistant',
      message_id: 'message-redacted',
      message: `line one\n${'x'.repeat(400)}`,
    };
    const first = registry.project('generic-agent-events', { value: record }, context);
    const second = registry.project('generic-agent-events', { value: record }, context);

    expect(first.summary).toBe(second.summary);
    expect(first.summary.length).toBeLessThanOrEqual(240);
    expect(first.summary).not.toContain('\n');
    expect(first.confidence).toBe('source');
    expect(first.evidence).toEqual(expect.arrayContaining([
      { field: 'eventKind', path: { tokens: [{ kind: 'key', value: 'event' }] } },
      { field: 'summary', path: { tokens: [{ kind: 'key', value: 'message' }] } },
      { field: 'actor', path: { tokens: [{ kind: 'key', value: 'role' }] } },
      { field: 'messageId', path: { tokens: [{ kind: 'key', value: 'message_id' }] } },
    ]));
  });

  it('returns Generic projection if a selected profile fails', () => {
    const registry = new AgentProfileRegistry({ includeBuiltins: false });
    registry.register({
      id: 'broken', displayName: 'Broken', version: '1', detect: () => ({
        profileId: 'broken', profileVersion: '1', score: 1, reasons: [], requiredEvidenceMet: true, sampledRecords: 0,
      }),
      project: () => { throw new Error('redacted'); },
    });
    expect(registry.project('broken', { value: 'raw survives' }, context)).toMatchObject({
      profileId: 'generic', eventKind: 'other', summary: 'raw survives',
    });
  });
});
