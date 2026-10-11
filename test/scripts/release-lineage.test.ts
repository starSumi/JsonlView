import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript gate intentionally has no emitted declarations.
import { compareSemver, normalizeCandidate, normalizeLedger, normalizeReadback, parseArgs, validateReleaseLineage } from '../../scripts/check-release-lineage.mjs';

const commit = 'a'.repeat(40);
const remote = 'b'.repeat(40);
const digests = {
  npm: '1'.repeat(64),
  'open-vsx': '2'.repeat(64),
  marketplace: '3'.repeat(64),
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'jsonlview-release-candidate',
    version: '0.2.9',
    state: 'candidate',
    source: {
      gitSha: commit,
      repository: 'github.com/starsumi/jsonlview',
      tag: 'v0.2.9',
      remoteRef: 'origin/main',
    },
    artifacts: [
      { surface: 'npm', coordinate: '@sumi-labs/jsonl-view', version: '0.2.9', sha256: digests.npm, bytes: 101 },
      { surface: 'open-vsx', coordinate: 'Sumi-Sophia.jsonl-view', version: '0.2.9', sha256: digests['open-vsx'], bytes: 202 },
      { surface: 'marketplace', coordinate: 'Sumi-Sophia.jsonlview-data-studio', version: '0.2.9', sha256: digests.marketplace, bytes: 303 },
    ],
    ...overrides,
  };
}

function ledger(entries: unknown[] = []) {
  return { schemaVersion: 1, kind: 'jsonlview-release-ledger', entries };
}

function readback(entries: unknown[] = []) {
  return { schemaVersion: 1, kind: 'jsonlview-registry-readbacks', entries };
}

function git(overrides: Record<string, unknown> = {}) {
  return {
    headSha: commit,
    tagState: 'absent',
    tagSha: undefined,
    remoteSha: remote,
    remoteContainsCandidate: false,
    candidateContainsRemote: true,
    ...overrides,
  };
}

function artifacts() {
  return candidate().artifacts;
}

describe('release lineage gate', () => {
  it('accepts an unpublished candidate while recording that registry readback is pending', () => {
    const result = validateReleaseLineage({ candidate: candidate(), ledger: ledger(), readback: readback(), git: git() });
    expect(result).toMatchObject({ ok: true, decision: 'new-candidate', ledger: { entries: 0 }, registryReadback: { entries: 0 } });
    expect(result.warnings).toContain('registry readback is absent for an unpublished candidate; publication remains gated');
  });

  it('normalizes conventional repository URLs at the external evidence boundary', () => {
    const result = validateReleaseLineage({
      candidate: candidate({ source: { ...candidate().source, repository: 'https://github.com/starSumi/JsonlView.git' } }),
      ledger: ledger(),
      readback: readback(),
      git: git(),
    });
    expect(result).toMatchObject({ ok: true, candidate: { source: { repository: 'github.com/starsumi/jsonlview' } } });
  });

  it('accepts an exact same-version replay and exposes the idempotency decision', () => {
    const existing = { version: '0.2.9', source: { gitSha: commit }, artifacts: artifacts() };
    const result = validateReleaseLineage({
      candidate: candidate(),
      ledger: ledger([existing]),
      readback: readback(),
      git: git({ tagState: 'exact', tagSha: commit, remoteContainsCandidate: true }),
    });
    expect(result).toMatchObject({ ok: true, decision: 'idempotent-replay', ledger: { matchingVersion: '0.2.9' } });
  });

  it('does not infer a release from a tag when the version ledger is missing', () => {
    const result = validateReleaseLineage({
      candidate: candidate(),
      ledger: ledger(),
      readback: readback(),
      git: git({ tagState: 'exact', tagSha: commit }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('version tag v0.2.9 exists but the ledger has no matching version entry');
  });

  it('rejects a same-version candidate when any artifact digest or source commit changes', () => {
    const existing = { version: '0.2.9', source: { gitSha: commit }, artifacts: artifacts() };
    const changed = candidate({
      source: { ...candidate().source, gitSha: 'c'.repeat(40) },
      artifacts: artifacts().map((item: { surface: string; sha256: string }) => item.surface === 'npm' ? { ...item, sha256: '4'.repeat(64) } : item),
    });
    const result = validateReleaseLineage({ candidate: changed, ledger: ledger([existing]), readback: readback(), git: git() });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'candidate source.gitSha does not match the checked-out HEAD',
      'existing version 0.2.9 differs: source commit differs',
      'existing version 0.2.9 differs: npm artifact coordinate, digest, or size differs',
    ]));
  });

  it('blocks a published candidate without complete tag, remote, and readback evidence', () => {
    const result = validateReleaseLineage({
      candidate: candidate({ state: 'published' }),
      ledger: ledger(),
      readback: readback(),
      git: git({ tagState: 'absent', remoteContainsCandidate: false, candidateContainsRemote: false, remoteSha: undefined }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'published candidate requires registry readback entries for every artifact surface',
      'published candidate requires an exact version tag at the candidate commit',
      'published candidate commit is not an ancestor of the declared remote ref',
    ]));
  });

  it('accepts a published candidate only when all registry readbacks bind exact bytes', () => {
    const result = validateReleaseLineage({
      candidate: candidate({ state: 'published' }),
      ledger: ledger([{ version: '0.2.9', source: { gitSha: commit }, artifacts: artifacts() }]),
      readback: readback(artifacts().map((item: { surface: string; coordinate: string; version: string; sha256: string; bytes: number }) => ({
        surface: item.surface, coordinate: item.coordinate, version: item.version, sha256: item.sha256, bytes: item.bytes, status: 'published',
      }))),
      git: git({ tagState: 'exact', tagSha: commit, remoteContainsCandidate: true }),
    });
    expect(result).toMatchObject({ ok: true, decision: 'idempotent-replay', registryReadback: { matchedSurfaces: ['npm', 'open-vsx', 'marketplace'] } });
  });

  it('rejects a registry readback that reports a different digest or status', () => {
    const result = validateReleaseLineage({
      candidate: candidate({ state: 'published' }),
      ledger: ledger(),
      readback: readback(artifacts().map((item: { surface: string; coordinate: string; version: string; sha256: string; bytes: number }) => ({
        surface: item.surface, coordinate: item.coordinate, version: item.version, sha256: item.surface === 'npm' ? 'f'.repeat(64) : item.sha256, bytes: item.bytes, status: item.surface === 'npm' ? 'not-found' : 'published',
      }))),
      git: git({ tagState: 'exact', tagSha: commit, remoteContainsCandidate: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'registry readback entries[0].status must be published',
      'registry readback digest differs for npm',
    ]));
  });

  it('rejects ledger artifact version drift and malformed readback byte counts', () => {
    const failures: string[] = [];
    normalizeLedger(ledger([{ version: '0.2.9', source: { gitSha: commit }, artifacts: artifacts().map((item: { version: string }) => ({ ...item, version: '0.2.8' })) }]), failures);
    normalizeReadback(readback([{ surface: 'npm', coordinate: '@sumi-labs/jsonl-view', version: '0.2.9', sha256: digests.npm, bytes: 0, status: 'published' }]), failures);
    expect(failures).toEqual(expect.arrayContaining([
      'ledger.entries[0].artifacts[0].version must equal the ledger version',
      'registry readback entries[0].bytes must be a positive safe integer when supplied',
    ]));
  });

  it('rejects a candidate below a version already recorded in the ledger', () => {
    const higher = { version: '0.3.0', source: { gitSha: remote }, artifacts: artifacts().map((item: { version: string }) => ({ ...item, version: '0.3.0' })) };
    const result = validateReleaseLineage({ candidate: candidate(), ledger: ledger([higher]), readback: readback(), git: git() });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('candidate version 0.2.9 is lower than a recorded release (0.3.0)');
  });

  it('fails closed for malformed external contracts and duplicate surfaces', () => {
    const failures: string[] = [];
    normalizeCandidate({ schemaVersion: 1, kind: 'wrong' }, failures);
    normalizeLedger({ schemaVersion: 1, kind: 'jsonlview-release-ledger', entries: [{ version: '0.2.9', source: { gitSha: commit }, artifacts: [] }, { version: '0.2.9', source: { gitSha: commit }, artifacts: [] }] }, failures);
    normalizeReadback({ schemaVersion: 1, kind: 'jsonlview-registry-readbacks', entries: [{ surface: 'npm', coordinate: 'x', version: '0.2.9', sha256: '0'.repeat(64), status: 'published' }, { surface: 'npm', coordinate: 'x', version: '0.2.9', sha256: '0'.repeat(64), status: 'published' }] }, failures);
    expect(failures).toEqual(expect.arrayContaining([
      'candidate must declare schemaVersion 1 and kind jsonlview-release-candidate',
      'ledger.entries[0].artifacts must contain exactly 3 entries',
      'registry readback contains duplicate npm:0.2.9',
    ]));
  });

  it('orders semantic versions including prereleases', () => {
    expect(compareSemver('0.2.9', '0.2.10')).toBeLessThan(0);
    expect(compareSemver('0.2.9-rc.2', '0.2.9-rc.10')).toBeLessThan(0);
    expect(compareSemver('0.2.9', '0.2.9-rc.10')).toBeGreaterThan(0);
  });

  it('requires all external CLI inputs and consumes only one separator', () => {
    expect(parseArgs(['--', '--candidate', 'candidate.json', '--ledger', 'ledger.json', '--registry-readback', 'readback.json']))
      .toMatchObject({ candidate: expect.stringContaining('candidate.json'), ledger: expect.stringContaining('ledger.json'), readback: expect.stringContaining('readback.json') });
    expect(() => parseArgs(['--candidate', 'candidate.json'])).toThrow(/--ledger is required/);
    expect(() => parseArgs(['--', '--', '--candidate', 'candidate.json'])).toThrow(/requires a value|unknown argument/);
  });
});
