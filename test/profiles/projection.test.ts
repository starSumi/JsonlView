import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry, isCodexTraceEvent, isUnixSeconds } from '../../src/profiles';
import {
  claudeFixture,
  claudeHistoryFixture,
  claudeJobTimelineFixture,
  codexExecFixture,
  codexHistoryFixture,
  codexRolloutAuxiliaryFixture,
  codexSessionIndexFixture,
  codexFixture,
  codexTraceFixture,
  genericAgentFixture,
} from './fixtures';

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

  it('treats Codex v1 task lifecycle aliases as a turn, not a sub-agent', () => {
    const registry = new AgentProfileRegistry();
    const started = registry.project('codex-rollout', {
      value: {
        timestamp: '2026-08-19T03:09:00.532Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-v1-redacted',
          started_at: 1787108940,
          model_context_window: 258400,
          collaboration_mode_kind: 'default',
        },
      },
    }, context);
    const completed = registry.project('codex-rollout', {
      value: {
        timestamp: '2026-08-19T03:09:31.079Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-v1-redacted',
          last_agent_message: 'Done',
          started_at: 1787108940,
          completed_at: 1787108971,
          duration_ms: 30559,
        },
      },
    }, context);

    expect(started).toMatchObject({ eventKind: 'turn', actor: 'assistant', turnId: 'turn-v1-redacted' });
    expect(started.subagentId).toBeUndefined();
    expect(completed).toMatchObject({
      eventKind: 'result',
      actor: 'assistant',
      turnId: 'turn-v1-redacted',
      summary: 'Turn complete: Done',
    });
    expect(completed.subagentId).toBeUndefined();
    expect(completed.evidence).toContainEqual({
      field: 'summary',
      path: { tokens: [{ kind: 'key', value: 'payload' }, { kind: 'key', value: 'last_agent_message' }] },
    });
  });

  it('projects Codex history and session-index surfaces with source evidence', () => {
    const registry = new AgentProfileRegistry();
    const history = registry.project('codex-history', { value: codexHistoryFixture[0] }, context);
    expect(history).toMatchObject({
      eventKind: 'message',
      actor: 'user',
      sessionId: codexHistoryFixture[0].session_id,
      timestamp: '2026-09-02T10:48:17.000Z',
      summary: 'Inspect the failing parser',
      derivedFields: { sourceKind: 'history' },
    });
    expect(history.evidence).toEqual(expect.arrayContaining([
      { field: 'timestamp', path: { tokens: [{ kind: 'key', value: 'ts' }] } },
      { field: 'sessionId', path: { tokens: [{ kind: 'key', value: 'session_id' }] } },
    ]));

    const index = registry.project('codex-session-index', { value: codexSessionIndexFixture[0] }, context);
    expect(index).toMatchObject({
      eventKind: 'session',
      actor: 'system',
      sessionId: codexSessionIndexFixture[0].id,
      timestamp: codexSessionIndexFixture[0].updated_at,
      summary: 'Parser investigation',
      derivedFields: { threadName: 'Parser investigation', sourceKind: 'session-index' },
    });
  });

  it('projects Codex exec events and nested thread items', () => {
    const registry = new AgentProfileRegistry();
    const rows = codexExecFixture.map((value) => registry.project('codex-exec-jsonl', { value }, context));
    expect(rows.map((row) => row.eventKind)).toEqual(['session', 'turn', 'message', 'tool_result', 'result']);
    expect(rows[0]).toMatchObject({ sessionId: 'thread-exec-redacted', actor: 'system' });
    expect(rows[2]).toMatchObject({ messageId: 'item-message-redacted', actor: 'assistant' });
    expect(rows[3]).toMatchObject({ toolCallId: 'item-command-redacted', status: 'completed' });
    expect(rows[4]?.usage).toEqual({ input: 12, output: 8, cached: 2 });
  });

  it('keeps a completed tool item as a tool call when no result field exists', () => {
    const registry = new AgentProfileRegistry();
    const row = registry.project('codex-exec-jsonl', {
      value: {
        type: 'item.completed',
        item: {
          id: 'item-command-redacted',
          type: 'command_execution',
          command: 'pnpm test',
          aggregated_output: '',
          status: 'completed',
        },
      },
    }, context);
    expect(row.eventKind).toBe('tool_result');

    const pending = registry.project('codex-exec-jsonl', {
      value: {
        type: 'item.completed',
        item: {
          id: 'item-command-pending',
          type: 'command_execution',
          command: 'pnpm test',
          status: 'completed',
        },
      },
    }, context);
    expect(pending.eventKind).toBe('tool_call');
  });

  it('projects the newer Codex rollout auxiliary tags without dropping them', () => {
    const registry = new AgentProfileRegistry();
    const rows = codexRolloutAuxiliaryFixture.map((value) => registry.project('codex-rollout', { value }, context));
    expect(rows.map((row) => row.eventKind)).toEqual(['subagent', 'usage', 'checkpoint', 'error', 'other']);
    expect(rows[1]?.usage).toEqual({ input: 4, output: 2, cached: 0, total: 6 });
    expect(rows[0]).toMatchObject({ subagentId: '/root/child', parentId: '/root' });
  });

  it('unwraps Codex rollout item_completed variants instead of collapsing them to other', () => {
    const registry = new AgentProfileRegistry();
    const envelope = (item: Record<string, unknown>, lifecycle = 'item_completed') => ({
      timestamp: '2026-09-08T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: lifecycle,
        thread_id: 'thread-rollout-redacted',
        turn_id: 'turn-rollout-redacted',
        item,
      },
    });
    const rows = [
      registry.project('codex-rollout', { value: envelope({ type: 'UserMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }) }, context),
      registry.project('codex-rollout', { value: envelope({ type: 'AgentMessage', id: 'message-1', content: [{ type: 'Text', text: '## Answer' }] }) }, context),
      registry.project('codex-rollout', { value: envelope({ type: 'Reasoning', id: 'reasoning-1', summary_text: ['checking'], raw_content: [] }) }, context),
      registry.project('codex-rollout', { value: envelope({ type: 'CommandExecution', id: 'exec-1', command: ['pwsh', '-NoProfile'], status: 'completed', aggregated_output: 'done', exit_code: 0 }) }, context),
      registry.project('codex-rollout', { value: envelope({ type: 'FileChange', id: 'patch-1', changes: [], status: 'completed' }) }, context),
      registry.project('codex-rollout', { value: envelope({ type: 'McpToolCall', id: 'mcp-1', server: 'server', tool: 'read', status: 'completed', result: { content: [] } }) }, context),
      registry.project('codex-rollout', { value: envelope({ type: 'SubAgentActivity', id: 'sub-1', kind: 'started', agent_thread_id: 'child-1', agent_path: '/root/child' }) }, context),
      registry.project('codex-rollout', { value: envelope({ type: 'CommandExecution', id: 'exec-2', command: ['pwsh'], status: 'completed' }, 'item_started') }, context),
    ];

    expect(rows.map((row) => row.eventKind)).toEqual([
      'message', 'message', 'reasoning', 'tool_result', 'patch', 'tool_result', 'subagent', 'tool_call',
    ]);
    expect(rows[0]).toMatchObject({ actor: 'user', sessionId: 'thread-rollout-redacted', turnId: 'turn-rollout-redacted' });
    expect(rows[1]).toMatchObject({ actor: 'assistant', messageId: 'message-1' });
    expect(rows[2]).toMatchObject({ actor: 'assistant', messageId: 'reasoning-1' });
    expect(rows[3]).toMatchObject({ actor: 'tool', toolCallId: 'exec-1', status: 'completed' });
    expect(rows[5]).toMatchObject({ toolCallId: 'mcp-1', actor: 'tool' });
    expect(rows[6]).toMatchObject({ subagentId: 'child-1', actor: 'agent' });
    expect(rows[7]?.derivedFields).toMatchObject({ lifecycle: 'started', wireItemType: 'CommandExecution' });
  });

  it('keeps extension and completed search/image items semantically distinct', () => {
    const registry = new AgentProfileRegistry();
    const envelope = (item: Record<string, unknown>) => ({
      timestamp: '2026-09-08T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'item_completed', item },
    });
    const rows = [
      registry.project('codex-rollout', { value: envelope({ id: 'extension-search', type: 'Extension', kind: 'web.search', query: 'jsonl', results: [{ title: 'result' }] }) }, context),
      registry.project('codex-rollout', { value: envelope({ id: 'extension-sleep', type: 'Extension', kind: 'clock.sleep', status: 'completed' }) }, context),
      registry.project('codex-rollout', { value: envelope({ id: 'search', type: 'WebSearch', action: { type: 'search', query: 'jsonl' }, status: 'completed' }) }, context),
      registry.project('codex-rollout', { value: envelope({ id: 'image', type: 'ImageGeneration', result: 'image-redacted', status: 'completed' }) }, context),
    ];

    expect(rows.map((row) => row.eventKind)).toEqual(['tool_result', 'action', 'tool_result', 'tool_result']);
    expect(rows[0]?.derivedFields).toMatchObject({ wireItemType: 'Extension', extensionKind: 'web.search' });
    expect(rows[1]?.derivedFields).toMatchObject({ wireItemType: 'Extension', extensionKind: 'clock.sleep' });
  });

  it('does not promote an item lifecycle envelope without a source-backed nested item', () => {
    const registry = new AgentProfileRegistry();
    const decision = registry.detect([
      { value: { timestamp: '2026-09-08T00:00:00.000Z', type: 'event_msg', payload: { type: 'item_completed' } }, ordinal: '0' },
      { value: { timestamp: '2026-09-08T00:00:01.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { id: 'x', type: 'FutureItem' } } }, ordinal: '1' },
    ]);
    expect(decision.selectedProfileId).toBe('generic');
  });

  it('gives Codex settings a semantic action kind while preserving unknown event types', () => {
    const registry = new AgentProfileRegistry();
    const settings = registry.project('codex-rollout', {
      value: {
        timestamp: '2026-09-08T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'thread_settings_applied',
          settings: { developer_instructions: '# Collaboration' },
        },
      },
    }, context);
    const unknown = registry.project('codex-rollout', {
      value: { timestamp: '2026-09-08T00:00:00.000Z', type: 'event_msg', payload: { type: 'future_event' } },
    }, context);
    expect(settings).toMatchObject({ eventKind: 'action', actor: 'system' });
    expect(unknown.eventKind).toBe('other');
  });

  it('projects Codex trace envelopes without hydrating payload references', () => {
    const registry = new AgentProfileRegistry();
    const rows = codexTraceFixture.map((value) => registry.project('codex-trace', { value }, context));
    expect(rows.map((row) => row.eventKind)).toEqual(['session', 'turn', 'tool_call', 'result']);
    expect(rows[0]).toMatchObject({
      sessionId: 'thread-trace-redacted',
      timestamp: '2026-09-02T10:48:17.000Z',
      derivedFields: { payloadType: 'rollout_started', seq: '1' },
    });
    expect(rows[2]).toMatchObject({ turnId: 'turn-trace-redacted', summary: expect.stringContaining('Run tests') });
  });

  it('preserves signed trace clock values and does not impose an arbitrary Unix-second ceiling', () => {
    const registry = new AgentProfileRegistry();
    const preEpoch = { ...codexTraceFixture[0]!, wall_time_unix_ms: -1 };
    expect(isCodexTraceEvent(preEpoch)).toBe(true);
    expect(registry.project('codex-trace', { value: preEpoch }, context).timestamp)
      .toBe('1969-12-31T23:59:59.999Z');
    expect(isUnixSeconds(10_000_000_001)).toBe(true);
    const future = { ...codexHistoryFixture[0]!, ts: 10_000_000_001 };
    expect(registry.project('codex-history', { value: future }, context)).toMatchObject({
      timestamp: '2286-11-20T17:46:41.000Z',
    });
  });

  it('preserves a Codex session-index unknown timestamp as derived raw data', () => {
    const value = { ...codexSessionIndexFixture[0]!, updated_at: 'unknown' };
    const projection = new AgentProfileRegistry().project('codex-session-index', { value }, context);
    expect(projection.timestamp).toBeUndefined();
    expect(projection.derivedFields?.timestampRaw).toBe('unknown');
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

  it('projects Claude job timeline snapshots as timestamped lifecycle records', () => {
    const registry = new AgentProfileRegistry();
    const row = registry.project('claude-code-session', {
      value: {
        at: '2026-08-06T10:47:38.133Z',
        state: 'blocked',
        detail: '3 options for session search',
        text: '## Delivery\n\n- **Index** the sessions\n- Rebuild the timeline',
      },
    }, context);

    expect(row).toMatchObject({
      eventKind: 'message',
      timestamp: '2026-08-06T10:47:38.133Z',
      status: 'blocked',
      summary: expect.stringContaining('Delivery'),
      derivedFields: { state: 'blocked', detail: '3 options for session search' },
    });
    expect(row.evidence).toEqual(expect.arrayContaining([
      { field: 'eventKind', path: { tokens: [{ kind: 'key', value: 'state' }] } },
      { field: 'summary', path: { tokens: [{ kind: 'key', value: 'text' }] } },
      { field: 'timestamp', path: { tokens: [{ kind: 'key', value: 'at' }] } },
    ]));
  });

  it('projects Claude history rows as user commands with a normalized timestamp', () => {
    const registry = new AgentProfileRegistry();
    const row = registry.project('claude-code-session', { value: claudeHistoryFixture[1] }, context);

    expect(row).toMatchObject({
      eventKind: 'message',
      actor: 'user',
      sessionId: 'session-history-redacted',
      timestamp: '2026-08-30T02:11:00.000Z',
      summary: 'Claude command: Inspect the failing parser',
      derivedFields: {
        sourceKind: 'history',
        project: 'C:/redacted/project',
      },
    });
    expect(row.evidence).toEqual(expect.arrayContaining([
      { field: 'summary', path: { tokens: [{ kind: 'key', value: 'display' }] } },
      { field: 'timestamp', path: { tokens: [{ kind: 'key', value: 'timestamp' }] } },
    ]));
  });

  it('keeps timeline strategy evidence explicit when text is empty', () => {
    const registry = new AgentProfileRegistry();
    const row = registry.project('claude-code-session', { value: claudeJobTimelineFixture[0] }, context);
    expect(row).toMatchObject({ eventKind: 'observation', status: 'working', derivedFields: { sourceKind: 'job-timeline' } });
    expect(row.evidence).toContainEqual({ field: 'summary', path: { tokens: [{ kind: 'key', value: 'detail' }] } });
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
