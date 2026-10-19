import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry, KimiCodeProfile } from '../../src/profiles';
import { decodeKimiServerEvent, isKimiServerHeader, KIMI_SERVER_EVENT_TYPES } from '../../src/profiles/kimi-server-record';

const clock = '2026-10-16T04:00:00.001Z';
const header = { kind: 'journal_header', version: 1, epoch: 'synthetic-epoch', created_at: 1792123200000 };
const event = (type: string, body: Record<string, unknown> = {}, seq = 1) => ({
  kind: 'event', seq, envelope: { type, seq, timestamp: clock,
    payload: { type, agentId: 'main', sessionId: 'synthetic-session', ...body } },
});
const profile = new KimiCodeProfile();
const project = (value: unknown) => profile.project({ value }, { generation: 'server-fixture' });
const path = (...keys: string[]) => ({ tokens: keys.map((value) => ({ kind: 'key', value })) });

describe('Kimi persisted server journal boundary', () => {
  it('recognizes v1 headers independently of wire metadata and keeps optional envelope fields optional', () => {
    expect(isKimiServerHeader(header)).toBe(true);
    for (const value of [null, {}, { ...header, version: 2 }, { ...header, epoch: '' },
      { ...header, created_at: '2026-10-16' }, { type: 'metadata', protocol_version: '1.5', created_at: 1792123200000 }]) {
      expect(isKimiServerHeader(value)).toBe(false);
    }
    const value = event('prompt.submitted', { content: [] });
    expect(decodeKimiServerEvent(value)).toEqual({ envelope: value.envelope, payload: value.envelope.payload, type: 'prompt.submitted' });
    expect(decodeKimiServerEvent({ ...value, envelope: { ...value.envelope, volatile: false, offset: 0 } })?.type)
      .toBe('prompt.submitted');
    expect(decodeKimiServerEvent({ ...value, envelope: { ...value.envelope, volatile: true, offset: 5 } })?.type)
      .toBe('prompt.submitted');
    const { type: _type, ...payload } = value.envelope.payload;
    expect(decodeKimiServerEvent({ ...value, envelope: { ...value.envelope, payload } })?.type).toBe('prompt.submitted');
    expect(new Set(KIMI_SERVER_EVENT_TYPES).size).toBe(KIMI_SERVER_EVENT_TYPES.length);
    expect(KIMI_SERVER_EVENT_TYPES).toEqual(expect.arrayContaining(['context.spliced', 'prompt.submitted', 'event.session.created', 'mcp.server.status']));
  });

  it('rejects malformed envelopes and conflicting discriminants without guessing nested keys', () => {
    const valid = event('prompt.submitted');
    for (const value of [null, [], {}, { jsonrpc: '2.0', method: 'event', params: valid },
      { ...valid, kind: 'message' }, { ...valid, seq: 0 },
      { ...valid, envelope: { ...valid.envelope, seq: 0 } },
      { ...valid, envelope: { ...valid.envelope, seq: 2 } },
      { ...valid, envelope: { ...valid.envelope, seq: '1' } },
      { ...valid, envelope: { ...valid.envelope, timestamp: 1792123200000 } },
      { ...valid, envelope: { ...valid.envelope, payload: null } },
      { ...valid, envelope: { ...valid.envelope, payload: { type: 'error' } } }]) {
      expect(decodeKimiServerEvent(value)).toBeUndefined();
    }
    for (const envelope of [
      { ...valid.envelope, volatile: 'true' },
      { ...valid.envelope, offset: '0' },
      { ...valid.envelope, offset: -1 },
      { ...valid.envelope, offset: 0.5 },
      { ...valid.envelope, offset: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(decodeKimiServerEvent({ ...valid, envelope })).toBeUndefined();
    }
    expect(decodeKimiServerEvent(event('future.kimi.event', { text: 'stay in Raw' }))?.type).toBe('future.kimi.event');
  });

  it('detects corroborated journals and headerless windows while public errors alone remain generic', () => {
    const submitted = event('prompt.submitted', { promptId: 'prompt-1', userMessageId: 'user-1', status: 'running', content: [{ type: 'text', text: 'Inspect a synthetic file.' }], createdAt: clock });
    const started = event('turn.started', { turnId: 0, origin: { kind: 'user' } }, 2);
    const completed = event('turn.step.completed', { turnId: 0, step: 1, finishReason: 'completed' }, 3);
    const detect = (values: unknown[]) => new AgentProfileRegistry().detect(values.map((value) => ({ value })));
    expect(detect([header, submitted]).selectedProfileId).toBe('kimi-code-session');
    expect(detect([submitted, started, completed]).selectedProfileId).toBe('kimi-code-session');
    expect(profile.version).toBe('3');
    for (const records of [[header], [submitted], [event('error', { code: 'internal', message: 'Synthetic failure', retryable: false })],
      [event('error'), event('error'), event('error')],
      [event('future.kimi.event'), event('future.kimi.event'), event('future.kimi.event')]]) {
      expect(detect(records).selectedProfileId).toBe('generic');
    }
    const withoutIdentity = { ...submitted, envelope: { ...submitted.envelope, payload: { type: 'prompt.submitted', content: [] } } };
    expect(detect([header, withoutIdentity]).selectedProfileId).toBe('generic');
    expect(detect([{ type: 'metadata', protocol_version: '1.5', created_at: 1792123200000 }, submitted]).selectedProfileId).toBe('generic');
    expect(profile.detect([{ value: header }, { value: submitted }, { value: undefined, parseState: 'blank' },
      { value: completed, parseState: 'invalid_json' }]).requiredEvidenceMet).toBe(false);
  });

  it('projects envelope identity and time with exact source evidence and no input mutation', () => {
    const value = event('prompt.submitted', { promptId: 'prompt-1', userMessageId: 'user-1', status: 'running',
      content: [{ type: 'text', text: 'Inspect a synthetic file.' }], createdAt: '2026-10-16T03:59:59.000Z' });
    const enriched = { ...value, envelope: { ...value.envelope, session_id: 'envelope-session' } };
    const before = JSON.stringify(enriched);
    const result = project(enriched);
    expect(result).toMatchObject({ profileId: 'kimi-code-session', eventKind: 'message', actor: 'user', messageId: 'user-1',
      sessionId: 'envelope-session', timestamp: clock, status: 'running', summary: expect.stringContaining('Inspect a synthetic file.') });
    expect(result.evidence).toEqual(expect.arrayContaining([
      { field: 'summary', path: path('envelope', 'payload', 'content') },
      { field: 'messageId', path: path('envelope', 'payload', 'userMessageId') },
      { field: 'sessionId', path: path('envelope', 'session_id') },
      { field: 'timestamp', path: path('envelope', 'timestamp') },
      { field: 'eventKind', path: path('envelope', 'type') },
    ]));
    expect(JSON.stringify(enriched)).toBe(before);
    expect(project(value).evidence).toContainEqual({ field: 'sessionId', path: path('envelope', 'payload', 'sessionId') });
  });

  it('projects session, prompt, turn, context and observer families with bounded fields', () => {
    const cases: Array<{ type: string; body: Record<string, unknown>; expected: Record<string, unknown> }> = [
      { type: 'event.session.created', body: { session: { id: 'session-1', title: 'Synthetic title', status: 'idle' } }, expected: { eventKind: 'session', summary: expect.stringContaining('Synthetic title'), status: 'idle' } },
      { type: 'session.meta.updated', body: { patch: { title: 'Updated title', lastPrompt: 'Updated prompt' } }, expected: { eventKind: 'session', summary: expect.stringContaining('Updated title') } },
      { type: 'event.session.status_changed', body: { status: 'running', previous_status: 'idle' }, expected: { eventKind: 'session', status: 'running' } },
      { type: 'prompt.completed', body: { promptId: 'p', reason: 'blocked' }, expected: { eventKind: 'turn', status: 'blocked' } },
      { type: 'prompt.aborted', body: { promptId: 'p' }, expected: { eventKind: 'turn', status: 'aborted' } },
      { type: 'turn.started', body: { turnId: 0, origin: { kind: 'user' } }, expected: { eventKind: 'turn', turnId: '0', status: 'running' } },
      { type: 'turn.step.started', body: { turnId: 0, step: 1, stepId: 'step-1' }, expected: { eventKind: 'turn', status: 'running', derivedFields: { step: 1, stepId: 'step-1' } } },
      { type: 'turn.step.completed', body: { turnId: 0, step: 1, finishReason: 'completed', usage: { inputOther: 11, inputCacheRead: 7, inputCacheCreation: 3, output: 5 } }, expected: { eventKind: 'turn', status: 'completed', usage: { input: 21, cached: 7, output: 5, total: 26 } } },
      { type: 'turn.step.retrying', body: { turnId: 0, errorMessage: 'Synthetic retry', nextAttempt: 2 }, expected: { eventKind: 'error', status: 'retrying', severity: 'warning', summary: expect.stringContaining('Synthetic retry') } },
      { type: 'turn.step.interrupted', body: { turnId: 0, reason: 'cancelled', message: 'Synthetic interruption' }, expected: { eventKind: 'turn', status: 'interrupted' } },
      { type: 'turn.ended', body: { turnId: 0, reason: 'failed', error: { code: 'internal', message: 'Synthetic failed turn' } }, expected: { eventKind: 'turn', status: 'failed', severity: 'error' } },
      { type: 'context.spliced', body: { start: 0, deleteCount: 0, messages: [{ id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'Synthetic response' }] }] }, expected: { eventKind: 'message', actor: 'assistant', summary: expect.stringContaining('Synthetic response') } },
      { type: 'error', body: { code: 'internal', message: 'Synthetic error', retryable: true }, expected: { eventKind: 'error', severity: 'error', summary: expect.stringContaining('Synthetic error') } },
      { type: 'tool.list.updated', body: { reason: 'mcp.connected', serverName: 'synthetic-tools' }, expected: { eventKind: 'observation', derivedFields: { serverName: 'synthetic-tools', reason: 'mcp.connected' } } },
      { type: 'mcp.server.status', body: { server: { name: 'synthetic-tools', status: 'connected', transport: 'stdio', toolCount: 2 } }, expected: { eventKind: 'observation', status: 'connected', derivedFields: { serverName: 'synthetic-tools', toolCount: 2 } } },
      { type: 'event.config.warning', body: { warnings: [{ message: 'Synthetic configuration warning' }] }, expected: { eventKind: 'observation', severity: 'warning', summary: expect.stringContaining('Synthetic configuration warning') } },
      { type: 'prompt.queued', body: { promptId: 'queued', content: [{ type: 'text', text: 'Queued prompt' }], queueLength: 1 }, expected: { eventKind: 'message', actor: 'user', status: 'queued', summary: expect.stringContaining('Queued prompt') } },
      { type: 'prompt.started', body: { promptId: 'started' }, expected: { eventKind: 'turn', status: 'running' } },
      { type: 'turn.steer', body: { messageId: 'steered-message', input: [{ type: 'text', text: 'Steered prompt' }] }, expected: { eventKind: 'message', actor: 'user', messageId: 'steered-message', summary: expect.stringContaining('Steered prompt') } },
      { type: 'task.notified', body: { title: 'Synthetic task notice', severity: 'info' }, expected: { eventKind: 'task', severity: 'info', summary: expect.stringContaining('Synthetic task notice') } },
      { type: 'plan.revision', body: { id: 'plan', version: 2, bytes: 100 }, expected: { eventKind: 'checkpoint', derivedFields: { version: 2, bytes: 100 } } },
      { type: 'event.question.requested', body: { question_id: 'q1', turn_id: 1, tool_call_id: 'question-tool', questions: [{ question: 'Choose a synthetic option.' }] }, expected: { eventKind: 'approval', status: 'requested', turnId: '1', toolCallId: 'question-tool', summary: expect.stringContaining('Choose a synthetic option.') } },
      { type: 'event.approval.resolved', body: { approval_id: 'a1', decision: 'deny', feedback: 'Synthetic refusal' }, expected: { eventKind: 'approval', actor: 'user', status: 'deny', summary: expect.stringContaining('Synthetic refusal') } },
      { type: 'cron.fired', body: { prompt: 'Inspect a synthetic scheduled job.', origin: { kind: 'cron_job', jobId: 'job-1' } }, expected: { eventKind: 'task', actor: 'system', summary: expect.stringContaining('Inspect a synthetic scheduled job.'), derivedFields: { jobId: 'job-1', origin: 'cron_job' } } },
    ];
    for (const testCase of cases) {
      const value = event(testCase.type, testCase.body);
      const projection = project(value);
      expect(projection, testCase.type).toMatchObject(testCase.expected);
      for (const item of projection.evidence) {
        let source: unknown = value;
        for (const token of item.path.tokens) source = source !== null && typeof source === 'object'
          ? (source as Record<string | number, unknown>)[token.value] : undefined;
        expect(source, testCase.type + ' evidence for ' + item.field).not.toBeUndefined();
      }
    }
    expect(project(event('prompt.submitted', { content: [{ type: 'text', text: 'x'.repeat(100_000) }] })).summary.length).toBeLessThanOrEqual(240);
  });

  it('keeps the source-derived server vocabulary exhaustively dispatched and physical headers separate', () => {
    for (const type of KIMI_SERVER_EVENT_TYPES) expect(project(event(type)).eventKind, type).not.toBe('other');
    expect(project(header)).toMatchObject({ eventKind: 'session', derivedFields: { journalVersion: 1 } });
    expect(project(header).derivedFields).not.toHaveProperty('protocolVersion');
    const missingClock = event('turn.started', { turnId: -1 });
    expect(project({ ...missingClock, envelope: { ...missingClock.envelope, timestamp: 'invalid' } })).not.toHaveProperty('timestamp');
    expect(project(missingClock)).not.toHaveProperty('turnId');
  });

  it('keeps unknown fields Raw-only, opaque content hidden and identities bounded', () => {
    const unknown = event('future.kimi.event', { command: 'DO_NOT_GUESS_COMMAND', nested: { text: 'DO_NOT_GUESS_TEXT' } });
    expect(project(unknown)).toMatchObject({ eventKind: 'other', summary: expect.stringContaining('future.kimi.event') });
    expect(JSON.stringify(project(unknown))).not.toMatch(/DO_NOT_GUESS/);
    expect(project({ ...header, version: 2 })).toMatchObject({ eventKind: 'other' });
    const prompt = project(event('prompt.submitted', { userMessageId: 'x'.repeat(3_000), content: [
      { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'opaque' },
      { type: 'image', source: { kind: 'base64', data: 'PRIVATE_IMAGE' } },
      { type: 'text', text: 'Visible prompt.' },
    ] }));
    expect(prompt.messageId).toBeUndefined();
    expect(prompt.derivedFields?.identityOmitted).toBe(true);
    expect(prompt.summary).toContain('Visible prompt.');
    expect(JSON.stringify(prompt)).not.toMatch(/PRIVATE_/);
    const content: unknown[] = Array.from({ length: 17 }, () => ({ type: 'text', text: '' }));
    Object.defineProperty(content, 16, { get: () => { throw new Error('outside content budget'); } });
    expect(() => project(event('prompt.submitted', { content }))).not.toThrow();
    const messages: unknown[] = Array.from({ length: 17 }, () => ({ role: 'assistant', content: [] }));
    Object.defineProperty(messages, 16, { get: () => { throw new Error('outside message budget'); } });
    expect(() => project(event('context.spliced', { messages }))).not.toThrow();
    const warnings: unknown[] = Array.from({ length: 17 }, () => ({ message: '' }));
    Object.defineProperty(warnings, 16, { get: () => { throw new Error('outside warning budget'); } });
    expect(() => project(event('event.config.warning', { warnings }))).not.toThrow();
    expect(project(event('tool.result', { output: 'Missing success flag' }))).not.toHaveProperty('status');
  });
});
