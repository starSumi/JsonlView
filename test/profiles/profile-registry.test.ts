import { describe, expect, it } from 'vitest';
import type { AgentRowProjection } from '../../src/shared/types';
import {
  AgentProfileRegistry,
  type AgentProfile,
  type DetectionResult,
  type GenericRecordSample,
} from '../../src/profiles';
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
  ordinaryJsonlFixture,
} from './fixtures';

const samples = (values: readonly unknown[]): GenericRecordSample[] => values.map((value, index) => ({ value, ordinal: String(index + 1) }));

describe('AgentProfileRegistry detection', () => {
  it('registers the built-in profiles in stable order', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.list().map((profile) => profile.id)).toEqual([
      'generic',
      'codex-rollout',
      'codex-exec-jsonl',
      'codex-trace',
      'codex-history',
      'codex-session-index',
      'claude-code-session',
      'generic-agent-events',
      'opentelemetry',
      'software-engineering-agent',
      'structured-application-log',
    ]);
  });

  it('detects Codex rollout records from content, not an external filename', () => {
    const decision = new AgentProfileRegistry().detect(samples(codexFixture));
    expect(decision.selectedProfileId).toBe('codex-rollout');
    expect(decision.ambiguous).toBe(false);
    expect(decision.suggestions[0]?.reasons.length).toBeGreaterThan(0);
  });

  it('does not promote a sparse Codex shape inside a mixed physical file', () => {
    const mixed = [
      ...codexFixture.slice(0, 4),
      ...Array.from({ length: 60 }, (_, index) => ({ noise: index, message: 'ordinary record' })),
    ];
    const decision = new AgentProfileRegistry().detect(samples(mixed));
    expect(decision.selectedProfileId).toBe('generic');
    expect(decision.detections.find((result) => result.profileId === 'codex-rollout')?.requiredEvidenceMet).toBe(false);
  });

  it('detects Codex exec JSONL from its exact tagged event contract', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples(codexExecFixture)).selectedProfileId).toBe('codex-exec-jsonl');
    expect(registry.detect(samples(codexExecFixture.slice(0, 2))).selectedProfileId).toBe('generic');
    expect(registry.detect(samples(codexExecFixture.map((value) => ({ ...value, type: 'other.event' })))).selectedProfileId).toBe('generic');
    const mixed = [
      ...codexExecFixture.slice(0, 2),
      ...Array.from({ length: 62 }, (_, index) => ({ message: `ordinary-${index}` })),
    ];
    expect(registry.detect(samples(mixed)).selectedProfileId).toBe('generic');

    const arbitraryItems = [
      { type: 'thread.started', thread_id: 'ordinary-thread' },
      { type: 'item.started', item: { id: 'ordinary-item-1', type: 'application_event' } },
      { type: 'item.completed', item: { id: 'ordinary-item-2', type: 'application_event' } },
    ];
    expect(registry.detect(samples(arbitraryItems)).selectedProfileId).toBe('generic');
  });

  it('requires source-backed Codex payload tags instead of trusting arbitrary type strings', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples([
      { timestamp: '2026-09-02T10:49:00.000Z', type: 'response_item', payload: { type: 'made_up_item' } },
      { timestamp: '2026-09-02T10:49:01.000Z', type: 'event_msg', payload: { type: 'made_up_event' } },
    ])).selectedProfileId).toBe('generic');
    expect(registry.detect(samples([
      { timestamp: '2026-09-02T10:49:00.000Z', type: 'retained_context', payload: {
        verified_answers: [], incomplete: false, user_messages: [], user_messages_incomplete: false, next_order: 2,
      } },
      { timestamp: '2026-09-02T10:49:01.000Z', type: 'security_risk_score', payload: { scores: {} } },
    ])).selectedProfileId).toBe('generic');
  });

  it('accepts an exact Codex exec thread with no item events', () => {
    const registry = new AgentProfileRegistry();
    const decision = registry.detect(samples([
      { type: 'thread.started', thread_id: 'thread-complete-only' },
      { type: 'turn.started' },
      { type: 'turn.completed', usage: {
        input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0,
      } },
    ]));
    expect(decision.selectedProfileId).toBe('codex-exec-jsonl');
  });

  it('validates the complete source shapes for exec tool items', () => {
    const records = [
      { type: 'thread.started', thread_id: 'thread-items' },
      { type: 'turn.started' },
      { type: 'item.started', item: {
        id: 'mcp-1', type: 'mcp_tool_call', server: 'server', tool: 'tool', arguments: {}, result: null, error: null, status: 'in_progress',
      } },
      { type: 'item.completed', item: {
        id: 'collab-1', type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: 'thread-items', receiver_thread_ids: [], prompt: null, agents_states: {}, status: 'completed',
      } },
      { type: 'item.completed', item: {
        id: 'search-1', type: 'web_search', query: 'jsonl', action: { type: 'search', query: 'jsonl' },
      } },
      { type: 'item.completed', item: {
        id: 'todo-1', type: 'todo_list', items: [{ text: 'inspect', completed: true }],
      } },
    ];
    expect(new AgentProfileRegistry().detect(samples(records)).selectedProfileId).toBe('codex-exec-jsonl');
  });

  it('keeps current auxiliary Codex rollout tags inside the rollout contract', () => {
    expect(new AgentProfileRegistry().detect(samples(codexRolloutAuxiliaryFixture)).selectedProfileId)
      .toBe('codex-rollout');
  });

  it('detects raw Codex trace envelopes and keeps trace basename weak', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples(codexTraceFixture)).selectedProfileId).toBe('codex-trace');
    expect(registry.detect(codexTraceFixture.slice(0, 2).map((value, index) => ({
      value,
      ordinal: String(index),
      sourcePathHint: 'C:/redacted/trace-redacted/trace.jsonl',
    }))).selectedProfileId).toBe('codex-trace');
    const mixed = [
      ...codexTraceFixture.slice(0, 2),
      ...Array.from({ length: 62 }, (_, index) => ({ noise: index })),
    ];
    expect(registry.detect(samples(mixed)).selectedProfileId).toBe('generic');
    expect(registry.detect(samples(codexTraceFixture.slice(0, 2).map((value) => ({
      ...value,
      payload: { type: 'application_specific_event' },
    })))).selectedProfileId).toBe('generic');
  });

  it('detects Codex auxiliary surfaces only after bounded shape corroboration', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples(codexHistoryFixture)).selectedProfileId).toBe('codex-history');
    expect(registry.detect(samples(codexSessionIndexFixture)).selectedProfileId).toBe('codex-session-index');

    // Common field names alone are not producer identity. Two records without
    // a trusted .codex locator remain Generic rather than being overfit.
    expect(registry.detect(samples(codexHistoryFixture.slice(0, 2))).selectedProfileId).toBe('generic');
    expect(registry.detect(samples(codexSessionIndexFixture.slice(0, 2))).selectedProfileId).toBe('generic');
    expect(registry.detect(samples(codexHistoryFixture.map((value) => ({
      ...value,
      session_id: `job-${'x'.repeat(30)}`,
    })))).selectedProfileId).toBe('generic');
    expect(registry.detect(codexHistoryFixture.slice(0, 2).map((value, index) => ({
      value,
      ordinal: String(index),
      sourcePathHint: 'C:/Users/redacted/.codex/history.jsonl',
    }))).selectedProfileId).toBe('codex-history');
    expect(registry.detect(codexSessionIndexFixture.slice(0, 2).map((value, index) => ({
      value,
      ordinal: String(index),
      sourcePathHint: 'C:/Users/redacted/.codex/session_index.jsonl',
    }))).selectedProfileId).toBe('codex-session-index');
    expect(registry.detect([
      ...codexHistoryFixture.slice(0, 2).map((value, index) => ({
        value,
        ordinal: String(index),
        sourcePathHint: 'C:/Users/redacted/.codex/history.jsonl',
      })),
      { value: codexHistoryFixture[2], ordinal: '2' },
    ]).selectedProfileId).toBe('generic');
  });

  it('rejects auxiliary lookalikes, wrong timestamp units, and mixed files', () => {
    const registry = new AgentProfileRegistry();
    const historyLookalikes = codexHistoryFixture.slice(0, 2).map((value) => ({
      session_id: value.session_id,
      ts: value.ts * 1000,
      text: value.text,
    }));
    expect(registry.detect(samples(historyLookalikes)).selectedProfileId).toBe('generic');
    expect(registry.detect(samples([
      ...codexHistoryFixture.slice(0, 3),
      { session_id: '01a061e0-2090-7343-abf9-4b16528826a2', ts: 'not-seconds', text: 'unrelated' },
    ])).selectedProfileId).toBe('generic');
    expect(registry.detect(samples(codexSessionIndexFixture.map((value) => ({
      ...value,
      updated_at: value.updated_at.replace('T', ' '),
    })))).selectedProfileId).toBe('generic');
    expect(registry.detect(samples(codexSessionIndexFixture.map((value) => ({
      ...value,
      updated_at: '2026-02-30T11:22:17Z',
    })))).selectedProfileId).toBe('generic');
    expect(registry.detect(codexSessionIndexFixture.map((value, index) => ({
      value: { ...value, updated_at: 'unknown' },
      ordinal: String(index),
      sourcePathHint: 'C:/Users/redacted/.codex/session_index.jsonl',
    }))).selectedProfileId).toBe('codex-session-index');
    expect(registry.detect(samples(codexSessionIndexFixture.map((value) => ({
      ...value,
      updated_at: 'unknown',
    })))).selectedProfileId).toBe('generic');
    expect(registry.detect(samples([
      { timestamp: '2026-09-02T10:49:00.000Z', type: 'token_usage_record', payload: {} },
      { timestamp: '2026-09-02T10:49:01.000Z', type: 'retained_context', payload: { entries: 2 } },
      { timestamp: '2026-09-02T10:49:02.000Z', type: 'security_risk_score', payload: { score: 0.2 } },
      { timestamp: '2026-09-02T10:49:03.000Z', type: 'realtime_item', payload: { event: 'audio_delta' } },
    ])).selectedProfileId).toBe('generic');
    expect(registry.detect(samples([
      ...codexSessionIndexFixture.slice(0, 3),
      { id: '01a061e0-2090-7343-abf9-4b16528826a2', thread_name: 'mixed', updated_at: '2026-09-02T11:22:17Z', extra: 1 },
    ])).selectedProfileId).toBe('codex-session-index');
  });

  it('does not promote a short exec prefix with only discriminator-shaped items', () => {
    const registry = new AgentProfileRegistry();
    const lookalike = [
      { type: 'thread.started', thread_id: 'thread-lookalike' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item-1', type: 'agent_message' } },
      { type: 'item.completed', item: { id: 'item-2', type: 'command_execution' } },
    ];
    expect(registry.detect(samples(lookalike)).selectedProfileId).toBe('generic');
  });

  it('counts malformed physical samples against specialized-profile coverage', () => {
    const registry = new AgentProfileRegistry();
    const physicalSamples: GenericRecordSample[] = [
      ...codexHistoryFixture.slice(0, 2).map((value, index) => ({
        value,
        ordinal: String(index),
        parseState: 'valid' as const,
        sourcePathHint: 'C:/Users/redacted/.codex/history.jsonl',
      })),
      { value: undefined, ordinal: '2', parseState: 'invalid_json' as const, sourcePathHint: 'C:/Users/redacted/.codex/history.jsonl' },
      { value: undefined, ordinal: '3', parseState: 'blank' as const, sourcePathHint: 'C:/Users/redacted/.codex/history.jsonl' },
    ];
    expect(registry.detect(physicalSamples).selectedProfileId).toBe('generic');
    expect(registry.detect(physicalSamples)
      .detections.find((result) => result.profileId === 'codex-history')?.score)
      .toBeLessThan(0.65);
  });

  it('detects Claude Code records without conflating Codex payload semantics', () => {
    const decision = new AgentProfileRegistry().detect(samples(claudeFixture));
    expect(decision.selectedProfileId).toBe('claude-code-session');
    expect(decision.detections.find((result) => result.profileId === 'codex-rollout')?.requiredEvidenceMet).toBe(false);
  });

  it('detects Claude job timelines from their distinct lifecycle envelope', () => {
    const decision = new AgentProfileRegistry().detect(claudeJobTimelineFixture.map((value, index) => ({
      value,
      ordinal: String(index + 1),
      sourcePathHint: 'C:/Users/redacted/.claude/jobs/job-redacted/timeline.jsonl',
    })));

    expect(decision.selectedProfileId).toBe('claude-code-session');
    expect(decision.detections.find((result) => result.profileId === 'claude-code-session')?.reasons)
      .toContainEqual(expect.objectContaining({ observation: expect.stringContaining('job timeline') }));
    expect(new AgentProfileRegistry().detect(samples([
      { at: '2026-08-06T10:33:35.710Z', state: 'working', text: 'not a Claude timeline' },
      { at: '2026-08-06T10:34:35.710Z', state: 'working', text: 'still not one' },
    ])).selectedProfileId).toBe('generic');
    expect(new AgentProfileRegistry().detect(samples(claudeJobTimelineFixture)).selectedProfileId).toBe('generic');
  });

  it('detects Claude command history only with its identity and timestamp evidence', () => {
    expect(new AgentProfileRegistry().detect(samples(claudeHistoryFixture)).selectedProfileId)
      .toBe('claude-code-session');
    expect(new AgentProfileRegistry().detect(samples([
      { display: 'ordinary label', timestamp: 1788055800000 },
      { display: 'another label', timestamp: 1788055860000 },
    ])).selectedProfileId).toBe('generic');
  });

  it('does not promote sparse Claude history rows inside a mixed physical file', () => {
    const mixed = [
      ...claudeHistoryFixture,
      ...Array.from({ length: 62 }, (_, index) => ({ noise: index, display: 'ordinary record' })),
    ];
    const decision = new AgentProfileRegistry().detect(samples(mixed));
    expect(decision.selectedProfileId).toBe('generic');
    expect(decision.detections.find((result) => result.profileId === 'claude-code-session')?.requiredEvidenceMet).toBe(false);
  });

  it('does not classify malformed or singleton timeline-looking records as Claude', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples([{
      at: 'not-a-timestamp', state: 'done', detail: 'x', text: 'y',
    }])).selectedProfileId).toBe('generic');
    expect(registry.detect(samples([claudeJobTimelineFixture[0]])).selectedProfileId).toBe('generic');
  });

  it('does not promote generic control types without a record identity', () => {
    const decision = new AgentProfileRegistry().detect(samples([
      { type: 'mode', sessionId: 'ordinary-session' },
      { type: 'permission-mode', sessionId: 'ordinary-session' },
      { type: 'attachment', sessionId: 'ordinary-session' },
    ]));
    expect(decision.selectedProfileId).toBe('generic');
    expect(decision.detections.find((result) => result.profileId === 'claude-code-session')?.requiredEvidenceMet).toBe(false);
  });

  it('detects conservative generic Agent events and rejects ordinary JSONL', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples(genericAgentFixture)).selectedProfileId).toBe('generic-agent-events');
    expect(registry.detect(samples(ordinaryJsonlFixture)).selectedProfileId).toBe('generic');
  });

  it('reads only the bounded detection sample', () => {
    const registry = new AgentProfileRegistry({ maxDetectionSamples: 2 });
    const decision = registry.detect(samples([...ordinaryJsonlFixture, ...codexFixture]));
    expect(decision.detections.every((result) => result.sampledRecords === 2)).toBe(true);
    expect(decision.selectedProfileId).toBe('generic');
  });

  it('falls back to Generic when equally credible profiles are ambiguous', () => {
    const registry = new AgentProfileRegistry({ includeBuiltins: false, detectionThreshold: 0.6 });
    registry.register(mockProfile('candidate-a', 0.8));
    registry.register(mockProfile('candidate-b', 0.76));
    const decision = registry.detect([{ value: { event: 'message' } }]);
    expect(decision.ambiguous).toBe(true);
    expect(decision.selectedProfileId).toBe('generic');
    expect(decision.suggestions.map((item) => item.id)).toEqual(['candidate-a', 'candidate-b']);
  });

  it('rejects duplicate registration and contains detection failures', () => {
    const registry = new AgentProfileRegistry({ includeBuiltins: false });
    expect(() => registry.register(mockProfile('generic'))).toThrow(/already registered/);
    registry.register({ ...mockProfile('broken'), detect: () => { throw new Error('redacted'); } });
    expect(registry.detect([{ value: {} }]).selectedProfileId).toBe('generic');
  });
});

function mockProfile(id: string, score = 0): AgentProfile {
  return {
    id,
    displayName: id,
    version: '1',
    detect(sample: readonly GenericRecordSample[]): DetectionResult {
      return {
        profileId: id,
        profileVersion: '1',
        score,
        reasons: score > 0 ? [{ path: { tokens: [] }, observation: 'synthetic evidence' }] : [],
        requiredEvidenceMet: score > 0,
        sampledRecords: sample.length,
      };
    },
    project(): AgentRowProjection {
      return { profileId: id, eventKind: 'other', summary: 'synthetic', evidence: [], confidence: 'inferred' };
    },
  };
}
