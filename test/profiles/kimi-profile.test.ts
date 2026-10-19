import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry, KimiCodeProfile, KIMI_SOURCE_REVISION } from '../../src/profiles';
import type { GenericRecordSample } from '../../src/profiles';
import { isKimiAgentCoreRecord, kimiContentPreview, kimiTimestamp, kimiUsage } from '../../src/profiles/kimi-record';
import { kimiWireFixture } from './kimi-fixtures';

const samples = (values: readonly unknown[]): GenericRecordSample[] => values.map((value) => ({ value }));
const profile = new KimiCodeProfile();
const project = (value: unknown) => profile.project({ value }, { generation: 'kimi-generation' });

describe('Kimi persisted wire detection', () => {
  it('selects Kimi by corroborated persisted shapes, including a headerless middle window', () => {
    const registry = new AgentProfileRegistry();
    expect(KIMI_SOURCE_REVISION).toHaveLength(40);
    expect(registry.detect(samples(kimiWireFixture)).selectedProfileId).toBe('kimi-code-session');
    expect(registry.detect(samples(kimiWireFixture.slice(2))).selectedProfileId).toBe('kimi-code-session');
    expect(registry.detect(samples(kimiWireFixture.slice(0, 2))).selectedProfileId).toBe('kimi-code-session');
    expect(registry.detect(samples([
      { type: 'metadata', protocol_version: '1.5', created_at: 1792123200000 },
      { type: 'profile.bind', agentId: 'main', thinkingEffort: 'on', systemPrompt: 'You are Kimi.', disallowedTools: [] },
    ])).selectedProfileId).toBe('kimi-code-session');
    expect(registry.detect(samples([
      { type: 'metadata', protocol_version: '1.5', created_at: 1792123200000 },
      { type: 'llm.tools_snapshot', agentId: 'main', hash: 'h', tools: [{ name: 'Lookup', description: 'Look up a value.', parameters: { type: 'object' } }] },
    ])).selectedProfileId).toBe('kimi-code-session');
  });

  it('detects metadata-anchored Kimi wire when MCP discovery records dominate the sample', () => {
    const records: unknown[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1792123200000 },
      { type: 'config.update', modelAlias: 'model', profileName: 'agent', systemPrompt: 'Synthetic system prompt', time: 1792123200001 },
      { type: 'config.update', systemPrompt: 'Synthetic updated prompt', time: 1792123200002 },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: 'mcp.tools_discovered', serverName: `server-${index}`,
        hash: `hash-${index}`, tools: [{ name: `tool-${index}`, description: 'Synthetic tool', inputSchema: { type: 'object' } }],
        enabledNames: [`tool-${index}`], time: 1792123200003 + index,
      })),
      { type: 'tools.set_active_tools', names: ['tool-1'], time: 1792123200015 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'Synthetic prompt' }], origin: { kind: 'user' }, time: 1792123200016 },
      { type: 'context.append_message', message: { content: [], origin: { kind: 'user' }, role: 'user', toolCalls: [] }, time: 1792123200017 },
      { type: 'context.append_loop_event', event: { step: 1, turnId: 0, type: 'step.begin', uuid: 'step-1' }, time: 1792123200018 },
    ];

    expect(records).toHaveLength(19);
    expect(new AgentProfileRegistry().detect(samples(records)).selectedProfileId).toBe('kimi-code-session');
  });

  it('detects Kimi when its complete 96-row source window contains the observed event mix', () => {
    const humanMessages = Array.from({ length: 17 }, (_, index) => ({
      type: 'agent.message.appended',
      kind: 'event',
      message: { message: { role: 'assistant', content: [{ type: 'text', text: `synthetic-${index}` }] } },
    }));
    const loopEvent = (event: Record<string, unknown>) => ({ type: 'context.append_loop_event', event });
    const loopEvents = [
      ...Array.from({ length: 9 }, (_, index) => loopEvent({ type: 'content.part', stepUuid: `step-${index}`, part: { type: 'text', text: 'synthetic' } })),
      ...Array.from({ length: 7 }, (_, index) => loopEvent({ type: 'tool.call', stepUuid: `step-${index}`, toolCallId: `call-${index}`, name: 'read' })),
      ...Array.from({ length: 7 }, (_, index) => loopEvent({ type: 'tool.result', toolCallId: `call-${index}`, result: { output: 'synthetic' } })),
      ...Array.from({ length: 6 }, (_, index) => loopEvent({ type: 'step.begin', uuid: `step-${index}` })),
      ...Array.from({ length: 6 }, (_, index) => loopEvent({ type: 'step.end', uuid: `step-${index}` })),
    ];
    const usage = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
    const taskInfo = { taskId: 'task', description: 'synthetic task', status: 'completed', kind: 'agent', startedAt: 1, endedAt: 2 };
    const records: unknown[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1792123200000 },
      { type: 'runtime.set_binding', agentId: 'main', workspaceId: 'workspace', runtimeId: 'local' },
      { type: 'permission.set_mode', agentId: 'main', mode: 'yolo' },
      { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi', profileName: 'agent', thinkingEffort: 'on', systemPrompt: 'bounded', disallowedTools: [] },
      ...Array.from({ length: 2 }, () => ({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'synthetic' }], origin: { kind: 'user' } })),
      ...Array.from({ length: 4 }, () => ({ type: 'context.append_message', agentId: 'main', message: { role: 'user', content: [], toolCalls: [] } })),
      ...humanMessages,
      ...Array.from({ length: 2 }, (_, turnId) => ({ type: 'agent.turn.started', kind: 'event', turnId })),
      { type: 'plugin.session_start', agentId: 'main', content: null },
      { type: 'llm.tools_snapshot', agentId: 'main', hash: 'hash', tools: [] },
      ...Array.from({ length: 6 }, () => ({ type: 'llm.request', agentId: 'main', kind: 'loop', provider: 'openai', model: 'kimi', systemPromptHash: 's', toolsHash: 't', toolSelect: false, messageCount: 1 })),
      ...Array.from({ length: 6 }, () => ({ type: 'usage.record', agentId: 'main', model: 'kimi', usage })),
      ...Array.from({ length: 6 }, () => ({ type: 'token_counting.measured', agentId: 'main', length: 1, tokens: 1 })),
      { type: 'task.started', agentId: 'main', info: taskInfo },
      { type: 'task.terminated', agentId: 'main', info: taskInfo },
      { type: 'prompt.steered', agentId: 'main', content: [] },
      { type: 'turn.steer', agentId: 'main', input: [], origin: { kind: 'user' } },
      ...Array.from({ length: 2 }, (_, turnId) => ({ type: 'agent.turn.ended', kind: 'event', turnId, outcome: 'done' })),
      ...Array.from({ length: 2 }, (_, turnId) => ({ type: 'turn.ended', agentId: 'main', turnId, reason: 'completed' })),
      ...Array.from({ length: 2 }, (_, turnId) => ({ type: 'token_counting.turn_recorded', agentId: 'main', turnId, length: 1, tokens: 1 })),
      ...Array.from({ length: 2 }, (_, index) => ({ type: 'prompt.completed', agentId: 'main', promptId: `prompt-${index}`, finishedAt: '2026-10-19T00:00:00.000Z', reason: 'completed' })),
      ...loopEvents,
    ];

    expect(records).toHaveLength(96);
    const result = profile.detect(samples(records));
    expect(result.requiredEvidenceMet).toBe(true);
    expect(result.profileId).toBe('kimi-code-session');
    expect(new AgentProfileRegistry().detect(samples(records)).selectedProfileId).toBe('kimi-code-session');
  });

  it('rejects malformed Kimi event lookalikes and accepts an omitted optional queue item id', () => {
    const invalidRecords = [
      { type: 'profile.bind', systemPrompt: 'lookalike' },
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
      { type: 'llm.request', agentId: 'main', kind: 'unknown', provider: 'p', model: 'm', systemPromptHash: 's', toolsHash: 't', toolSelect: false, messageCount: 1 },
      { type: 'usage.record', agentId: 'main', model: 'm', usage: { output: 1 } },
      { type: 'task.terminated', agentId: 'main', info: { taskId: 'task' } },
      { type: 'prompt.completed', agentId: 'main', promptId: 'prompt', reason: 'completed' },
      { type: 'prompt.completed', agentId: 'main', promptId: 'prompt', finishedAt: 'now', reason: 'maybe' },
    ];

    expect(isKimiAgentCoreRecord({ type: 'agent.turn.started', kind: 'event', turnId: 1 })).toBe(true);
    expect(invalidRecords.every((value) => !isKimiAgentCoreRecord(value))).toBe(true);
  });

  it('does not identify repeated MCP discovery records without corroborating wire evidence', () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      type: 'mcp.tools_discovered', serverName: `server-${index}`, hash: `hash-${index}`,
      tools: [{ name: `tool-${index}`, description: 'Synthetic tool', inputSchema: { type: 'object' } }],
      enabledNames: [`tool-${index}`], time: 1792123200000 + index,
    }));

    expect(new AgentProfileRegistry().detect(samples(records)).selectedProfileId).not.toBe('kimi-code-session');
  });

  it('rejects singleton metadata, producer lookalikes and transport JSON-RPC envelopes', () => {
    const registry = new AgentProfileRegistry();
    for (const records of [
      [kimiWireFixture[0]],
      [kimiWireFixture[1]],
      [{ type: 'metadata', protocol_version: '1.5', created_at: 'yesterday' }, kimiWireFixture[1]],
      [{ type: 'context.append_message', message: { role: 'user', content: 'wrong', toolCalls: [] } }],
      [{ jsonrpc: '2.0', method: 'event', params: kimiWireFixture[1] }],
      [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'ordinary' }] }],
    ]) expect(registry.detect(samples(records)).selectedProfileId).toBe('generic');
  });

  it('counts invalid and blank physical records against coverage and preserves the registry sample cap', () => {
    const values: GenericRecordSample[] = [
      ...samples(kimiWireFixture.slice(0, 2)),
      { value: kimiWireFixture[2], parseState: 'invalid_json' },
      { value: undefined, parseState: 'blank' },
    ];
    expect(profile.detect(values).requiredEvidenceMet).toBe(false);
    const registry = new AgentProfileRegistry({ maxDetectionSamples: 2 });
    expect(registry.detect(samples([{ unrelated: true }, {}, ...kimiWireFixture])).selectedProfileId).toBe('generic');
    expect(profile.detect(samples([...kimiWireFixture.slice(0, 2), ...Array.from({ length: 60 }, () => ({}))])).requiredEvidenceMet).toBe(false);
  });
});

describe('Kimi physical projections', () => {
  it('projects Kimi profile bindings with a bounded system prompt field', () => {
    const systemPrompt = 'You are Kimi Code CLI, an interactive general AI agent.';
    expect(project({ type: 'profile.bind', agentId: 'main', profileName: 'agent', thinkingEffort: 'on', disallowedTools: [], systemPrompt }))
      .toMatchObject({
        eventKind: 'session',
        actor: 'system',
        derivedFields: { systemPrompt },
        evidence: expect.arrayContaining([{
          field: 'systemPrompt',
          path: { tokens: [{ kind: 'key', value: 'systemPrompt' }] },
        }]),
      });
  });

  it('projects the typed Kimi event union without flattening content into Raw', () => {
    const toolSnapshot = project({ type: 'llm.tools_snapshot', agentId: 'main', hash: 'tools-hash', tools: [
      { name: 'Lookup', description: 'Look up a short value.', parameters: { type: 'object' } },
      { name: 'Search', description: 'Find matching records.', parameters: { type: 'object' } },
    ] });
    expect(toolSnapshot).toMatchObject({
      eventKind: 'observation',
      actor: 'system',
      derivedFields: {
        toolsHash: 'tools-hash', toolsCount: 2, toolNames: 'Lookup, Search',
        toolDescriptions: 'Lookup: Look up a short value. | Search: Find matching records.',
      },
    });
    expect(toolSnapshot.evidence).toContainEqual({ field: 'toolDescriptions', path: { tokens: [{ kind: 'key', value: 'tools' }] } });
    expect(project({ type: 'context.append_loop_event', event: {
      type: 'content.part', stepUuid: 'step', part: { type: 'think', think: 'Inspect the source.' },
    } })).toMatchObject({ eventKind: 'reasoning', summary: expect.stringContaining('Inspect the source') });
    expect(project({ type: 'context.append_loop_event', event: {
      type: 'tool.call', stepUuid: 'step', toolCallId: 'call', command: 'Get-ChildItem',
    } })).toMatchObject({ eventKind: 'tool_call', derivedFields: { toolCommand: 'Get-ChildItem' } });
    expect(project({ type: 'context.append_loop_event', event: {
      type: 'tool.result', toolCallId: 'call', result: { output: 'done', note: 'completed' },
    } })).toMatchObject({ eventKind: 'tool_result', summary: expect.stringContaining('done'), derivedFields: { resultNote: 'completed' } });
    expect(project({ type: 'task.started', taskId: 'task', info: { description: 'Index the workspace' } })).toMatchObject({
      eventKind: 'task', actor: 'system', derivedFields: { taskDescription: 'Index the workspace' },
    });
    expect(project({ type: 'prompt.steered', content: [{ type: 'text', text: 'Use the focused file.' }] })).toMatchObject({
      eventKind: 'message', actor: 'user', derivedFields: { contentPartCount: 1 },
    });
  });

  it('projects Kimi config updates with their model and reasoning settings', () => {
    expect(project({ type: 'config.update', modelAlias: 'model', profileName: 'agent', thinkingEffort: 'high' }))
      .toMatchObject({ derivedFields: { modelAlias: 'model', profileName: 'agent', thinkingEffort: 'high' } });
  });

  it('projects MCP discovery records as bounded tool inventory observations', () => {
    expect(project({
      type: 'mcp.tools_discovered', serverName: 'lookup-server', hash: 'tools-hash',
      tools: [{ name: 'lookup', description: 'Synthetic tool', inputSchema: { type: 'object' } }],
      enabledNames: ['lookup'],
    })).toMatchObject({
      profileId: 'kimi-code-session', eventKind: 'observation', actor: 'system',
      derivedFields: { serverName: 'lookup-server', toolsHash: 'tools-hash', toolsCount: 1, toolNames: 'lookup', enabledToolNames: 'lookup' },
    });
  });

  it('projects active tool selection without recursively rendering tool definitions', () => {
    expect(project({ type: 'tools.set_active_tools', names: ['lookup', 'read'] })).toMatchObject({
      profileId: 'kimi-code-session', eventKind: 'observation', actor: 'system',
      derivedFields: { activeToolCount: 2, activeToolNames: 'lookup, read' },
    });
  });

  it('projects Kimi turn prompts as messages with origin and prompt identity', () => {
    expect(project({
      type: 'turn.prompt', input: [{ type: 'text', text: 'Synthetic prompt' }],
      origin: { kind: 'user' }, promptId: 'prompt-1', turnId: 1,
    })).toMatchObject({
      profileId: 'kimi-code-session', eventKind: 'message', actor: 'user',
      summary: expect.stringContaining('Synthetic prompt'),
      turnId: '1',
      derivedFields: { origin: 'user', promptId: 'prompt-1', contentPartCount: 1 },
    });
  });

  it('projects agent-core lifecycle, request, usage, task, and appended-message records', () => {
    const projectedMessage = project({ type: 'agent.message.appended', kind: 'event', message: {
      message: { role: 'user', content: [{ type: 'text', text: 'Synthetic human message' }] },
    } });
    expect(projectedMessage).toMatchObject({ eventKind: 'message', actor: 'user' });
    expect(projectedMessage.summary).toContain('Synthetic human message');
    expect(projectedMessage.evidence).toContainEqual({ field: 'summary', path: { tokens: [
      { kind: 'key', value: 'message' }, { kind: 'key', value: 'message' }, { kind: 'key', value: 'content' },
    ] } });

    expect(project({ type: 'agent.turn.started', kind: 'event', turnId: 2 })).toMatchObject({ eventKind: 'turn', status: 'running', turnId: '2' });
    expect(project({ type: 'agent.turn.ended', kind: 'event', turnId: 2, outcome: 'done' })).toMatchObject({ eventKind: 'turn', status: 'completed', turnId: '2' });
    expect(project({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'failed' })).toMatchObject({ eventKind: 'turn', status: 'failed', turnId: '2' });
    expect(project({ type: 'runtime.set_binding', agentId: 'main', workspaceId: 'workspace', runtimeId: 'local' }))
      .toMatchObject({ eventKind: 'observation', derivedFields: { workspaceId: 'workspace', runtimeId: 'local' } });
    expect(project({ type: 'permission.set_mode', agentId: 'main', mode: 'manual' }))
      .toMatchObject({ eventKind: 'observation', derivedFields: { permissionMode: 'manual' } });
    const pluginSession = project({ type: 'plugin.session_start', agentId: 'main', content: 'PRIVATE_PLUGIN_PROMPT' });
    expect(pluginSession).toMatchObject({ eventKind: 'session', derivedFields: { pluginContentLength: 21 } });
    expect(JSON.stringify(pluginSession)).not.toContain('PRIVATE_PLUGIN_PROMPT');
    expect(project({ type: 'llm.request', agentId: 'main', kind: 'loop', provider: 'openai', model: 'kimi', systemPromptHash: 's', toolsHash: 't', toolSelect: false, messageCount: 3 }))
      .toMatchObject({ eventKind: 'observation', derivedFields: { provider: 'openai', model: 'kimi', messageCount: 3 } });
    expect(project({ type: 'usage.record', agentId: 'main', model: 'kimi', usage: { inputOther: 1, output: 4, inputCacheRead: 3, inputCacheCreation: 2 } }))
      .toMatchObject({ eventKind: 'observation', usage: { input: 6, cached: 3, output: 4, total: 10 } });
    expect(project({ type: 'token_counting.measured', agentId: 'main', length: 12, tokens: 7 }))
      .toMatchObject({ eventKind: 'observation', derivedFields: { length: 12, tokens: 7 } });
    expect(project({ type: 'token_counting.turn_recorded', agentId: 'main', turnId: 2, length: 12, tokens: 7 }))
      .toMatchObject({ eventKind: 'observation', turnId: '2', derivedFields: { length: 12, tokens: 7 } });
    expect(project({ type: 'turn.steer', agentId: 'main', input: [{ type: 'text', text: 'Synthetic steering prompt' }], origin: { kind: 'user' }, turnId: 2 }))
      .toMatchObject({ eventKind: 'message', actor: 'user', turnId: '2', summary: expect.stringContaining('Synthetic steering prompt') });
    expect(project({ type: 'prompt.completed', agentId: 'main', promptId: 'prompt', finishedAt: '2026-10-19T00:00:00.000Z', reason: 'completed' }))
      .toMatchObject({ eventKind: 'turn', status: 'completed', derivedFields: { promptId: 'prompt', finishedAt: '2026-10-19T00:00:00.000Z' } });
    expect(project({ type: 'task.terminated', agentId: 'main', info: { taskId: 'task', description: 'synthetic task', status: 'completed', kind: 'agent', startedAt: 1, endedAt: 2 } }))
      .toMatchObject({ eventKind: 'task', status: 'completed', derivedFields: { taskDescription: 'synthetic task' } });

    const privateRequest = project({ type: 'llm.request', agentId: 'main', kind: 'loop', provider: 'openai', model: 'kimi', systemPromptHash: 's', toolsHash: 't', toolSelect: false, messageCount: 3, systemPrompt: 'PRIVATE_REQUEST_PROMPT' });
    const privateTask = project({ type: 'task.terminated', agentId: 'main', info: { taskId: 'task', description: 'synthetic task', status: 'completed', kind: 'agent', startedAt: 1, endedAt: 2 }, outputTail: 'PRIVATE_TASK_OUTPUT' });
    expect(JSON.stringify([privateRequest, privateTask])).not.toContain('PRIVATE_REQUEST_PROMPT');
    expect(JSON.stringify([privateRequest, privateTask])).not.toContain('PRIVATE_TASK_OUTPUT');
  });

  it('maps user, assistant, thinking and tool records with source paths and millisecond clocks', () => {
    const records = kimiWireFixture.map(project);
    expect(records.map((record) => record.eventKind)).toEqual(['session', 'message', 'turn', 'reasoning', 'tool_call', 'tool_result', 'message', 'turn']);
    expect(records[1]).toMatchObject({ actor: 'user', messageId: 'message-user', timestamp: '2026-10-16T04:00:00.001Z', derivedFields: { agentId: 'main', origin: 'user' } });
    expect(records[3]!.summary).toContain('Inspect only');
    expect(records[4]).toMatchObject({ actor: 'assistant', messageId: 'call-event-1', toolCallId: 'call-1', turnId: '0', derivedFields: { stepUuid: 'step-1', toolName: 'Bash' } });
    expect(records[5]).toMatchObject({ actor: 'tool', parentId: 'call-event-1', toolCallId: 'call-1', status: 'completed' });
    expect(records[7]).toMatchObject({ status: 'completed', usage: { input: 21, cached: 7, output: 5, total: 26 } });
    // step.begin and step.end reuse uuid upstream; it is not a unique message ID.
    expect(records[2]!.messageId).toBeUndefined();
    expect(records[7]!.messageId).toBeUndefined();
    expect(records[4]!.evidence).toContainEqual({ field: 'toolCallId', path: { tokens: [{ kind: 'key', value: 'event' }, { kind: 'key', value: 'toolCallId' }] } });
    expect(records.every((record) => record.sessionId === undefined)).toBe(true);
  });

  it('correlates tool pairs across batches from exact source IDs', () => {
    const registry = new AgentProfileRegistry();
    const call = { recordKey: 'call-row', projection: project(kimiWireFixture[4]) };
    const result = { recordKey: 'result-row', projection: project(kimiWireFixture[5]) };
    const first = registry.correlate(profile.id, 'kimi-generation', [call]);
    const second = registry.correlate(profile.id, 'kimi-generation', [result], first.state);
    expect(second.relations).toContainEqual(expect.objectContaining({ kind: 'tool_pair', sourceRecordKey: 'call-row', targetRecordKey: 'result-row', stableId: 'call-1' }));
    expect(second.relations).toContainEqual(expect.objectContaining({ kind: 'parent_child', sourceRecordKey: 'call-row', targetRecordKey: 'result-row' }));
  });

  it('supports persisted 1.0 nested function tool calls without migrating the input', () => {
    const value = { type: 'context.append_message', message: {
      id: 'legacy-assistant', role: 'assistant', content: [], toolCalls: [
        { type: 'function', id: 'legacy-call', function: { name: 'Bash', arguments: '{"command":"printf legacy"}' } },
      ],
    } };
    const before = JSON.stringify(value);
    expect(project(value)).toMatchObject({ eventKind: 'tool_call', actor: 'assistant', toolCallId: 'legacy-call', derivedFields: { toolName: 'Bash', toolCallCount: 1 } });
    expect(JSON.stringify(value)).toBe(before);
    const multiple = { ...value, message: { ...value.message, toolCalls: [...value.message.toolCalls, { ...value.message.toolCalls[0], id: 'second-call' }] } };
    expect(project(multiple).toolCallId).toBeUndefined();
    expect(project(multiple).derivedFields?.toolCallCount).toBe(2);
  });

  it('marks explicit tool errors while leaving missing success status unknown', () => {
    expect(project({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'c', result: { output: 'failed', isError: true } } })).toMatchObject({ eventKind: 'tool_result', status: 'error', severity: 'error' });
    expect(project({ type: 'context.append_message', message: { role: 'tool', content: [{ type: 'text', text: 'failed' }], toolCalls: [], toolCallId: 'c', isError: true } })).toMatchObject({ actor: 'tool', toolCallId: 'c', status: 'error' });
    expect(project({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'c', result: { output: '' } } }).status).toBeUndefined();
  });

  it('retains undo, clear, compaction and cancellation as physical bookkeeping rows', () => {
    const history = [kimiWireFixture[1],
      { type: 'context.undo', agentId: 'main', count: 1 },
      { type: 'context.undone', agentId: 'main', turns: 1, fromTurnId: 0 },
      { type: 'context.clear', agentId: 'main' },
      { type: 'context.apply_compaction', agentId: 'main', contextSummary: 'Synthetic compacted context.', compactedCount: 3, tokensBefore: 100, tokensAfter: 20 },
      { type: 'full_compaction.cancel', agentId: 'main' },
    ];
    const before = JSON.stringify(history);
    expect(history.map(project)).toHaveLength(history.length);
    expect(history.slice(1).map(project).every((record) => record.eventKind === 'checkpoint')).toBe(true);
    expect(project(history[4])).toMatchObject({ summary: 'Kimi compaction: Synthetic compacted context.', derivedFields: { compactedCount: 3, tokensBefore: 100, tokensAfter: 20 } });
    expect(project(history[5]).status).toBe('cancelled');
    expect(JSON.stringify(history)).toBe(before);
  });

  it('recognizes durable interruption, retry and prompt termination without claiming success', () => {
    expect(project({ type: 'turn.step.interrupted', agentId: 'main', turnId: 0, step: 1, reason: 'cancelled' })).toMatchObject({ eventKind: 'turn', turnId: '0', status: 'interrupted' });
    expect(project({ type: 'turn.step.retrying', agentId: 'main', turnId: 2, errorMessage: 'Synthetic transport error' })).toMatchObject({ eventKind: 'error', turnId: '2', status: 'retrying', severity: 'warning' });
    expect(project({ type: 'prompt.aborted', promptId: 'p1' })).toMatchObject({ eventKind: 'turn', status: 'aborted' });
    expect(project({ type: 'prompt.completed', agentId: 'main', promptId: 'p2', finishedAt: '2026-10-19T00:00:00.000Z', reason: 'blocked' }).status).toBe('blocked');
  });

  it('keeps media and external tool output references inert and hidden thinking opaque', () => {
    const record = { type: 'context.append_message', message: { role: 'assistant', toolCalls: [], content: [
      { type: 'think', think: 'PRIVATE_HIDDEN', hidden: true },
      { type: 'think', think: 'PRIVATE_ENCRYPTED', encrypted: 'ciphertext' },
      { type: 'think', think: 'PRIVATE_EMPTY_CIPHER', encrypted: '' },
      { type: 'think', think: 'PRIVATE_MALFORMED_CIPHER', encrypted: null },
      { type: 'image_url', imageUrl: { url: 'file:///never-read.png' } },
      { type: 'audio_url', audioUrl: { url: 'https://example.invalid/never-fetch' } },
      { type: 'video_url', videoUrl: { url: 'data:video;base64,NEVER_DECODE' } },
    ] } };
    const summary = project(record).summary;
    expect(summary).toContain('[hidden reasoning]');
    expect(summary).toContain('[image reference]');
    expect(summary).toContain('[audio reference]');
    expect(summary).toContain('[video reference]');
    expect(summary).not.toMatch(/PRIVATE_|never-read|never-fetch|NEVER_DECODE|ciphertext/);
    expect(project({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'c', result: { output: 'output_path: /external/inert.txt' } } }).summary).toContain('output_path: /external/inert.txt');
  });

  it('bounds content scanning and projections, keeps unknown/malformed records and never truncates identities into collisions', () => {
    const parts: unknown[] = Array.from({ length: 17 }, () => ({ type: 'text', text: '' }));
    Object.defineProperty(parts, 16, { get: () => { throw new Error('outside part budget'); } });
    expect(kimiContentPreview(parts)).toBe('');
    const projection = project({ type: 'context.append_message', message: { role: 'assistant', id: 'a'.repeat(10000), toolCalls: [], content: [{ type: 'text', text: 'x'.repeat(1000000) }] } });
    expect(projection.summary.length).toBeLessThanOrEqual(240);
    expect(projection.messageId).toBeUndefined();
    expect(projection.derivedFields?.identityOmitted).toBe(true);
    for (const value of [null, 4, [], {}, { type: 'future.type', future: {} }, { type: 'context.append_message', message: null }, { type: 'context.append_loop_event', event: { type: 'future.loop', data: [] } }]) {
      expect(project(value)).toMatchObject({ profileId: 'kimi-code-session', eventKind: 'other' });
    }
  });
});

describe('Kimi token and clock contracts', () => {
  it('does not invent absent input buckets, accept negative/overflow token counts, or throw on invalid clocks', () => {
    expect(kimiUsage({ output: 2, inputCacheRead: 3 })).toEqual({ output: 2, cached: 3 });
    expect(kimiUsage({ inputOther: -1, inputCacheRead: 0, inputCacheCreation: 0, output: -1 })).toEqual({ cached: 0 });
    expect(kimiUsage({ inputOther: Number.MAX_SAFE_INTEGER, inputCacheRead: 1, inputCacheCreation: 0 })).toEqual({ cached: 1 });
    expect(kimiUsage({ inputOther: Infinity, output: NaN })).toBeUndefined();
    expect(kimiTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    for (const value of [undefined, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER]) expect(kimiTimestamp(value)).toBeUndefined();
  });
});
