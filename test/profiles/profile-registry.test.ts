import { describe, expect, it } from 'vitest';
import type { AgentRowProjection } from '../../src/shared/types';
import {
  AgentProfileRegistry,
  type AgentProfile,
  type DetectionResult,
  type GenericRecordSample,
} from '../../src/profiles';
import { claudeFixture, codexFixture, genericAgentFixture, ordinaryJsonlFixture } from './fixtures';

const samples = (values: readonly unknown[]): GenericRecordSample[] => values.map((value, index) => ({ value, ordinal: String(index + 1) }));

describe('AgentProfileRegistry detection', () => {
  it('registers the built-in profiles in stable order', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.list().map((profile) => profile.id)).toEqual([
      'generic',
      'codex-rollout',
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

  it('detects Claude Code records without conflating Codex payload semantics', () => {
    const decision = new AgentProfileRegistry().detect(samples(claudeFixture));
    expect(decision.selectedProfileId).toBe('claude-code-session');
    expect(decision.detections.find((result) => result.profileId === 'codex-rollout')?.requiredEvidenceMet).toBe(false);
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
