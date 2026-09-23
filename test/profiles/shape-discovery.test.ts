import { describe, expect, it } from 'vitest';
import {
  discoverShape,
  inferRecordSignals,
  CODEX_SOURCE_REVISION,
  SOURCE_SURFACE_CATALOG,
  sourceSurfaceEvidence,
  valueAtPath,
} from '../../src/profiles';

describe('bounded structural discovery', () => {
  it('infers nested signals without a provider-specific vocabulary', () => {
    const value = {
      envelope: {
        event_kind: 'tool_result',
        occurred_at: '2026-09-02T10:48:17.959Z',
        actor: { role: 'tool' },
        payload: { message: 'command completed', request_id: 'request-1234567890' },
      },
    };
    const signals = inferRecordSignals(value);

    expect(signals.discriminator?.value).toBe('tool_result');
    expect(signals.timestamp?.value).toBe('2026-09-02T10:48:17.959Z');
    expect(signals.summary?.value).toBe('command completed');
    expect(signals.identities[0]?.value).toBe('request-1234567890');
    expect(valueAtPath(value, signals.summary!.path)).toBe('command completed');
  });

  it('bounds traversal and records field kinds rather than materializing a schema claim', () => {
    const shape = discoverShape([
      { value: { type: 'message', payload: { text: 'one' } } },
      { value: { type: 'tool', payload: { text: 'two', count: 2 } } },
    ], { maxDepth: 3 });

    expect(shape.sampleCount).toBe(2);
    expect(shape.fields.some((field) => field.displayPath === '$.payload.text')).toBe(true);
    expect(shape.discriminator).toMatchObject({ key: 'type' });
  });

  it('treats producer path hints as weak or strong evidence explicitly', () => {
    expect(sourceSurfaceEvidence('C:/Users/redacted/.codex/history.jsonl')).toMatchObject({
      kind: 'codex-history', strength: 'strong',
    });
    expect(sourceSurfaceEvidence('C:/tmp/history.jsonl')).toBeUndefined();
    expect(sourceSurfaceEvidence('C:/tmp/renamed.ndjson')).toBeUndefined();
  });

  it('keeps source-backed serializer evidence versioned and inspectable', () => {
    const history = SOURCE_SURFACE_CATALOG.find((surface) => surface.kind === 'codex-history');
    const index = SOURCE_SURFACE_CATALOG.find((surface) => surface.kind === 'codex-session-index');
    expect(CODEX_SOURCE_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(history).toMatchObject({
      producerRepository: 'openai/codex',
      producerRevision: CODEX_SOURCE_REVISION,
      serializationAnchor: 'serde_json::to_string(HistoryEntry)',
      requiredPaths: ['session_id', 'ts', 'text'],
    });
    expect(index).toMatchObject({
      producerRepository: 'openai/codex',
      producerRevision: CODEX_SOURCE_REVISION,
      serializationAnchor: 'serde_json::to_string(SessionIndexEntry)',
      requiredPaths: ['id', 'thread_name', 'updated_at'],
    });
  });

  it('keeps every discovered Codex surface assigned to an explicit disposition', () => {
    const expected = new Map([
      ['codex-exec-jsonl', 'profiled'],
      ['codex-trace', 'profiled'],
      ['codex-tui-session-log', 'generic-compatible'],
      ['codex-analytics-capture', 'generic-compatible'],
      ['codex-app-server', 'generic-compatible'],
      ['codex-app-server-log', 'profiled'],
      ['codex-compressed-rollout', 'explicitly-unsupported'],
    ]);
    for (const [kind, disposition] of expected) {
      const descriptor = SOURCE_SURFACE_CATALOG.find((surface) => surface.kind === kind);
      expect(descriptor, kind).toMatchObject({
        disposition,
        producerRepository: 'openai/codex',
        producerRevision: CODEX_SOURCE_REVISION,
      });
    }
    expect(sourceSurfaceEvidence('C:/redacted/trace-1/trace.jsonl')).toMatchObject({
      kind: 'codex-trace', strength: 'weak', disposition: 'profiled', locator: 'content',
    });
    expect(sourceSurfaceEvidence('C:/redacted/rollout-1.jsonl.zst')).toMatchObject({
      kind: 'codex-compressed-rollout', strength: 'weak', disposition: 'explicitly-unsupported',
    });
  });

  it('recognizes source-backed archived rollouts and the opt-in TUI session logger', () => {
    expect(sourceSurfaceEvidence('C:/Users/redacted/.codex/archived_sessions/rollout-01abc.jsonl')).toMatchObject({
      kind: 'codex-rollout', strength: 'strong',
    });
    expect(sourceSurfaceEvidence('C:/Users/redacted/.codex/log/session-20260908T103255Z.jsonl')).toMatchObject({
      kind: 'codex-tui-session-log', strength: 'strong', disposition: 'generic-compatible',
    });
    expect(sourceSurfaceEvidence('C:/tmp/session-20260908T103255Z.jsonl')).toMatchObject({
      kind: 'codex-tui-session-log', strength: 'weak',
    });
  });
});
