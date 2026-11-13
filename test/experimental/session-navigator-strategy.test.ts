import { describe, expect, it } from 'vitest';
import { getSessionCatalogStrategy } from '../../src/experimental/session-navigator/session-catalog-strategy';
import type { SessionNavigatorProviderId } from '../../src/experimental/session-navigator/types';

const providers: readonly SessionNavigatorProviderId[] = [
  'codex', 'claude', 'pi', 'kimi', 'gemini', 'opencode', 'agentsview', 'generic',
];

describe('Session Catalog provider strategies', () => {
  it('defines a policy for every supported source without tree-provider provider branches', () => {
    expect(providers.map((provider) => getSessionCatalogStrategy(provider).provider)).toEqual(providers);
    expect(getSessionCatalogStrategy('kimi').refreshPriority).toBeLessThan(getSessionCatalogStrategy('codex').refreshPriority);
  });

  it('keeps Claude warmup retry and relationship prefetch within its source policy', () => {
    const policy = getSessionCatalogStrategy('claude');
    expect(policy.initialLoad).toEqual({
      emptyTruncatedRetry: { maxAttempts: 2, statusDetail: 'Waiting for Claude metadata…' },
      maximumPages: 2,
    });
    expect(policy.isRetryableEmptyScan({
      fingerprint: 'f',
      snapshot: { schemaVersion: 1, provider: 'claude', sourceId: 's', snapshotId: 'x', sourceGeneration: 'g', capturedAt: 'now', redaction: 'metadata-only', entities: [], relations: [], locations: [], truncated: true },
    })).toBe(true);
  });

  it('owns Codex state-database root normalization and source anchor policy', () => {
    const policy = getSessionCatalogStrategy('codex');
    expect(policy.resolveLocationRoot('C:/Users/user/.codex/state_3.sqlite')).toBe('C:/Users/user/.codex');
    expect(policy.allowsStaleLocation({ nativeId: 'thread', relativePath: 'sessions/thread.jsonl', rowOrdinal: '0' })).toBe(true);
    expect(policy.allowsStaleLocation({ nativeId: 'thread', relativePath: 'sessions/thread.jsonl', rowOrdinal: '1' })).toBe(false);
    expect(getSessionCatalogStrategy('generic').allowsStaleLocation({ nativeId: 'thread', relativePath: 'thread.jsonl', rowOrdinal: '0' })).toBe(false);
  });
});
