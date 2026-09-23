import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentSummary } from '../../src/shared/types';
import {
  FollowRecoveryCoordinator,
  isTransientFileLockError,
  postMessageBestEffort,
  shouldNotifyFollowRecovery,
  type FollowRecoveryHost,
  type FollowRecoveryIdentity,
  type FollowRecoveryProbe,
} from '../../src/extension/follow-recovery';

const expected: FollowRecoveryIdentity = {
  documentId: 'doc-1',
  uri: 'file:///events.jsonl',
  generation: 'generation-1',
  sizeBytes: '10',
  device: '7',
  inode: '11',
};

const recoveredSummary: DocumentSummary = {
  snapshot: {
    documentId: expected.documentId,
    generation: 'generation-2',
    uri: expected.uri,
    scheme: 'file',
    sizeBytes: '12',
    mtimeMs: 2,
    device: '7',
    inode: '11',
    prefixFingerprint: 'sha256:test:12',
    observedAt: new Date(0).toISOString(),
  },
  profileId: 'generic',
  profileSuggestions: [],
  indexedBytes: '12',
  indexedRecords: '2',
  indexingComplete: true,
  validRecords: '2',
  problemRecords: '0',
};

const coordinators: FollowRecoveryCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
});

function present(size: bigint, mtimeNs = 2n): FollowRecoveryProbe {
  return {
    kind: 'present',
    identity: { ...expected, sizeBytes: size.toString() },
    sizeBytes: size,
    mtimeNs: BigInt(mtimeNs),
  };
}

function createHost(probes: FollowRecoveryProbe[]): FollowRecoveryHost & {
  invalidations: string[];
  reports: string[];
  published: DocumentSummary[];
  rebuilds: number;
} {
  let current = expected;
  const host = {
    invalidations: [] as string[],
    reports: [] as string[],
    published: [] as DocumentSummary[],
    rebuilds: 0,
    getExpectedIdentity: () => expected,
    isExpectedIdentityCurrent: (identity: FollowRecoveryIdentity) => identity.generation === current.generation,
    probe: async (_signal: AbortSignal): Promise<FollowRecoveryProbe> => probes.shift() ?? present(12n),
    rebuildStable: async (_identity: FollowRecoveryIdentity, _signal: AbortSignal): Promise<DocumentSummary> => {
      host.rebuilds += 1;
      current = { ...current, generation: 'generation-2', sizeBytes: '12' };
      return recoveredSummary;
    },
    publish: async (summary: DocumentSummary) => {
      host.published.push(summary);
    },
    invalidate: async (reason: 'truncate' | 'replace' | 'delete' | 'unknown') => {
      host.invalidations.push(reason);
    },
    report: async (message: string) => {
      host.reports.push(message);
    },
  } satisfies FollowRecoveryHost & {
    invalidations: string[];
    reports: string[];
    published: DocumentSummary[];
    rebuilds: number;
  };
  return host;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for follow recovery.');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe('FollowRecoveryCoordinator', () => {
  it.each([
    { error: Object.assign(new Error('sharing violation'), { code: 'ERROR_SHARING_VIOLATION' }), expected: true },
    { error: Object.assign(new Error('busy'), { code: 'EBUSY' }), expected: true },
    { error: Object.assign(new Error('sharing violation'), { errno: 32 }), expected: true },
    { error: new Error('permission denied'), expected: false },
  ])('classifies transient Windows/file-lock errors without broadening unknown errors', ({ error, expected: result }) => {
    expect(isTransientFileLockError(error)).toBe(result);
  });

  it.each([
    { follow: true, running: false, kind: 'delete' as const, expected: true },
    { follow: true, running: false, kind: 'replace' as const, expected: true },
    { follow: true, running: false, kind: 'unknown' as const, expected: true },
    { follow: true, running: true, kind: 'append' as const, expected: true },
    { follow: true, running: false, kind: 'append' as const, expected: false },
    { follow: true, running: true, kind: 'truncate' as const, expected: false },
    { follow: false, running: true, kind: 'delete' as const, expected: false },
  ])('routes $kind refresh into recovery only when follow policy permits', ({ follow, running, kind, expected: result }) => {
    expect(shouldNotifyFollowRecovery(follow, running, kind)).toBe(result);
  });

  it('publishes only after two quiet, growing probes and a stable candidate', async () => {
    const host = createHost([present(12n), present(12n)]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxDelayMs: 4,
      maxWindowMs: 200,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.published.length === 1);

    expect(host.rebuilds).toBe(1);
    expect(host.invalidations).toEqual([]);
    expect(coordinator.recoveryState).toBe('idle');
  });

  it('stops as truncate before opening a candidate when the source shrinks', async () => {
    const host = createHost([present(9n)]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxWindowMs: 100,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.invalidations.length === 1);

    expect(host.invalidations).toEqual(['truncate']);
    expect(host.rebuilds).toBe(0);
  });

  it('does not reinterpret a same-size unknown rewrite as append', async () => {
    const host = createHost([present(10n)]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxWindowMs: 100,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.invalidations.length === 1);

    expect(host.invalidations).toEqual(['unknown']);
    expect(host.reports[0]).toMatch(/changed without verified growth/i);
    expect(host.rebuilds).toBe(0);
  });

  it('reports non-retryable probe errors without an unbounded retry loop', async () => {
    const host = createHost([{
      kind: 'error',
      message: 'permission denied',
      retryable: false,
    }]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxWindowMs: 100,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.reports.length === 1);

    expect(host.invalidations).toEqual(['unknown']);
    expect(host.reports[0]).toMatch(/permission denied/i);
    expect(coordinator.attemptCount).toBe(1);
  });

  it.each([
    { kind: 'missing' as const, label: 'missing path' },
    { kind: 'not_file' as const, label: 'non-file path' },
  ])('recovers when an atomic-save $label gap is followed by stable growth', async ({ kind }) => {
    const host = createHost([
      { kind },
      present(12n),
      present(12n),
    ]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxDelayMs: 4,
      maxWindowMs: 200,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.published.length === 1);

    expect(host.invalidations).toEqual([]);
    expect(host.rebuilds).toBe(1);
    expect(coordinator.recoveryState).toBe('idle');
  });

  it.each([
    { kind: 'missing' as const, reason: 'delete' as const },
    { kind: 'not_file' as const, reason: 'replace' as const },
  ])('retires a persistent $kind gap only after confirmation', async ({ kind, reason }) => {
    const host = createHost([{ kind }, { kind }]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxDelayMs: 4,
      maxWindowMs: 200,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.invalidations.length === 1);

    expect(host.invalidations).toEqual([reason]);
    expect(host.rebuilds).toBe(0);
    expect(coordinator.attemptCount).toBe(2);
  });

  it('treats mixed missing/non-file gaps as a confirmed replacement', async () => {
    const host = createHost([
      { kind: 'missing' },
      { kind: 'not_file' },
    ]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxDelayMs: 4,
      maxWindowMs: 200,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.invalidations.length === 1);

    expect(host.invalidations).toEqual(['replace']);
    expect(coordinator.attemptCount).toBe(2);
  });

  it('does not retire on a present-to-gap transition before the path recovers', async () => {
    const host = createHost([
      present(12n),
      { kind: 'missing' },
      present(12n),
      present(12n),
    ]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxDelayMs: 4,
      maxWindowMs: 200,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.published.length === 1);

    expect(host.invalidations).toEqual([]);
    expect(host.rebuilds).toBe(1);
  });

  it('keeps recovery successful when one panel rejects a recovered-generation message', async () => {
    const host = createHost([present(12n), present(12n)]);
    const diagnostics: string[] = [];
    const panels = [
      { postMessage: async () => { throw new Error('panel disposed'); } },
      { postMessage: async () => true },
    ];
    host.publish = async (summary) => {
      await postMessageBestEffort(panels, summary, (error, index) => {
        diagnostics.push(`${String(index)}:${error instanceof Error ? error.message : String(error)}`);
      });
      host.published.push(summary);
    };
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxWindowMs: 200,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.published.length === 1);

    expect(host.invalidations).toEqual([]);
    expect(coordinator.recoveryState).toBe('idle');
    expect(diagnostics).toEqual(['0:panel disposed']);
  });

  it('does not turn a deadline during panel publication into a late success', async () => {
    const host = createHost([present(12n), present(12n)]);
    let releasePublish: () => void = () => undefined;
    const publication = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    host.publish = async (summary) => {
      host.published.push(summary);
      await publication;
    };
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 1,
      quietPeriodMs: 1,
      maxWindowMs: 30,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    await waitFor(() => host.published.length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    releasePublish();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(host.invalidations).toEqual(['unknown']);
    expect(coordinator.recoveryState).toBe('exhausted');
  });

  it('cancels a pending run without invalidating or publishing', async () => {
    const host = createHost([present(12n), present(12n)]);
    const coordinator = new FollowRecoveryCoordinator(host, {
      initialDelayMs: 20,
      quietPeriodMs: 1,
      maxWindowMs: 100,
    });
    coordinators.push(coordinator);

    coordinator.notifyUnknown();
    coordinator.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(host.invalidations).toEqual([]);
    expect(host.published).toEqual([]);
    expect(host.rebuilds).toBe(0);
    expect(coordinator.recoveryState).toBe('idle');
  });
});
