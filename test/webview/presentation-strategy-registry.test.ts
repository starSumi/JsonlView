import { describe, expect, it, vi } from 'vitest';
import type { AgentRowProjection } from '../../src/shared/types';

const builders = vi.hoisted(() => ({
  claude: vi.fn(() => [{ title: 'claude' }]),
  pi: vi.fn(() => [{ title: 'pi' }]),
  kimi: vi.fn(() => [{ title: 'kimi' }]),
  generic: vi.fn(() => [{ title: 'generic' }]),
}));

vi.mock('../../src/webview/providers/claude-event-builder', () => ({
  buildClaudeEventSections: builders.claude,
}));
vi.mock('../../src/webview/providers/pi-event-builder', () => ({
  buildPiEventSections: builders.pi,
}));
vi.mock('../../src/webview/providers/kimi-event-builder', () => ({
  buildKimiEventSections: builders.kimi,
}));
vi.mock('../../src/webview/providers/generic-event-builder', () => ({
  buildGenericAgentEventSections: builders.generic,
}));

import {
  buildProviderEventSections,
  hasPresentationStrategy,
  type PresentationStrategyContext,
} from '../../src/webview/providers/presentation-strategy-registry';

const context = {} as PresentationStrategyContext;
const input = (profileId: string): { envelope: Record<string, unknown>; payload: Record<string, unknown>; profile: AgentRowProjection; envelopeType: string } => ({
  envelope: {},
  payload: {},
  profile: { profileId, eventKind: 'message', summary: 'test', evidence: [], confidence: 'source' },
  envelopeType: 'event',
});

describe('presentation strategy registry', () => {
  it.each([
    ['claude-code-session', builders.claude],
    ['pi-coding-agent', builders.pi],
    ['kimi-code-session', builders.kimi],
    ['generic-agent-events', builders.generic],
  ] as const)('dispatches %s to its owned builder', (profileId, builder) => {
    vi.clearAllMocks();

    const sections = buildProviderEventSections(input(profileId), context);

    expect(builder).toHaveBeenCalledTimes(1);
    expect(sections).toEqual([{ title: profileId === 'claude-code-session' ? 'claude' : profileId === 'pi-coding-agent' ? 'pi' : profileId === 'kimi-code-session' ? 'kimi' : 'generic' }]);
    for (const other of Object.values(builders)) {
      if (other !== builder) expect(other).not.toHaveBeenCalled();
    }
  });

  it('returns no strategy for unknown or absent profiles', () => {
    expect(hasPresentationStrategy('unknown-agent')).toBe(false);
    expect(hasPresentationStrategy(undefined)).toBe(false);
    expect(buildProviderEventSections({ ...input('unknown-agent'), profile: undefined }, context)).toEqual([]);
  });

  it('dispatches OpenTelemetry envelopes to the semantic envelope builder', () => {
    const sections = buildProviderEventSections({
      envelope: { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'checkout' }] }] }] },
      payload: {},
      profile: {
        profileId: 'opentelemetry', eventKind: 'span', summary: 'OTLP spans envelope',
        evidence: [], confidence: 'source',
      },
      envelopeType: undefined,
    }, context);

    expect(sections).toEqual([expect.objectContaining({ title: 'OTLP envelope', text: expect.stringContaining('Nested span records: 1') })]);
  });
});
