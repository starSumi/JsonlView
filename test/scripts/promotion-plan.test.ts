import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript CLI module intentionally does not emit declarations.
import { buildPromotionJoin, buildPromotionPlan, parseArgs } from '../../scripts/promotion-plan.mjs';
// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { computeVsixPairSha256 } from '../../scripts/verify-vsix-targets.mjs';

const source = {
  gitSha: 'a'.repeat(40),
  gitState: 'clean',
  statusSha256: 'b'.repeat(64),
  diffSha256: 'c'.repeat(64),
};

function fixtures() {
  const pair = {
    schemaVersion: 1,
    ok: true,
    version: '0.1.10',
    targets: {
      openVsx: { key: 'open-vsx', registry: 'open-vsx', extensionId: 'Sumi-Sophia.jsonl-view', name: 'jsonl-view', displayName: 'JsonlView', publisher: 'Sumi-Sophia', version: '0.1.10', sha256: 'd'.repeat(64), preservesUpdateChain: true },
      marketplace: { key: 'marketplace', registry: 'visual-studio-marketplace', extensionId: 'Sumi-Sophia.jsonlview-data-studio', name: 'jsonlview-data-studio', displayName: 'JsonlView Data Studio', publisher: 'Sumi-Sophia', version: '0.1.10', sha256: 'f'.repeat(64), preservesUpdateChain: false },
    },
    sharedPayload: { files: 89, nativeSha256: '1'.repeat(64), bundleSha256: '2'.repeat(64) },
    allowedIdentityDifferences: ['extension.vsixmanifest', 'extension/package.json'],
  };
  const pairSha256 = computeVsixPairSha256(pair);
  return {
    preflight: { ok: true, mode: 'public-release', checks: { git: { revision: source.gitSha, gitState: source.gitState, statusSha256: source.statusSha256, diffSha256: source.diffSha256, remoteConfigured: true }, package: { name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', private: false, license: 'MIT', repository: 'github.com/starsumi/jsonlview' }, npmCandidate: { approvedName: '@sumi-labs/jsonl-view', integrity: true, clean: true, tarball: { bytes: 100, sha256: 'e'.repeat(64) } }, vsixCandidate: { integrity: true, actualBytes: 200, actualSha256: 'd'.repeat(64), target: { key: 'open-vsx', registry: 'open-vsx', extensionId: 'Sumi-Sophia.jsonl-view', displayName: 'JsonlView', preservesUpdateChain: true } }, vsixPair: { ...pair, pairSha256, selectedTarget: 'open-vsx', selected: pair.targets.openVsx }, nativeProvenance: { ok: true, committedBinaryChecked: true, contractEqual: true, behaviorEqual: true } }, failures: [] as Array<{ check: string }> },
    local: { source: { sha: source.gitSha, clean: true, statusSha256: source.statusSha256, diffSha256: source.diffSha256 }, candidate: { name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', sha256: 'd'.repeat(64), extensionId: 'Sumi-Sophia.jsonl-view' }, vscode: { status: 'installed', activeWindowReloaded: true, reloadRequired: false } },
    vsix: { source, package: { name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', private: false, license: 'MIT' }, artifact: { bytes: 200, sha256: 'd'.repeat(64) } },
    npm: { source, package: { name: '@sumi-labs/jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', private: false, license: 'MIT' }, tarball: { bytes: 100, sha256: 'e'.repeat(64) } },
  };
}

describe('promotion plan', () => {
  it('joins one clean candidate set and leaves every public target pending authorization', () => {
    const plan = buildPromotionPlan(fixtures());
    expect(plan.readyForPromotion).toBe(true);
    expect(plan.publication).toMatch(/plan-only/);
    expect(plan.authorization).toMatchObject({ required: true, supplied: false });
    expect(plan.targets.github.status).toBe('pending-authorization');
    expect(plan.targets.localVsCode.reloadEvidence).toBe('manifest');
    expect(plan.targets.npm.publicationAttempted).toBe(false);
    expect(plan.targets.openVsx.readbackRequired).toBe(true);
    expect(plan.targets.marketplace.status).toBe('not-applicable');
    expect(plan.candidate.approvedNpmName).toBe('@sumi-labs/jsonl-view');
    expect(plan.candidate.vsixPairSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks a dirty or failed preflight and never upgrades target status', () => {
    const input = fixtures();
    input.preflight.ok = false;
    input.preflight.checks.git.gitState = 'dirty';
    input.preflight.failures = [{ check: 'git.clean' }];
    input.local.source.clean = false;
    const plan = buildPromotionPlan(input);
    expect(plan.readyForPromotion).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('preflight is not green'),
      expect.stringContaining('local.source.gitState is not clean'),
    ]));
    expect(plan.targets.github.status).toBe('blocked-by-gate');
    expect(plan.authorization.supplied).toBe(false);
  });

  it('creates a Marketplace-only plan for the alternate extension coordinate', () => {
    const input = fixtures();
    input.preflight.checks.vsixCandidate.target = {
      key: 'marketplace',
      registry: 'visual-studio-marketplace',
      extensionId: 'Sumi-Sophia.jsonlview-data-studio',
      displayName: 'JsonlView Data Studio',
      preservesUpdateChain: false,
    };
    input.preflight.checks.vsixPair.selectedTarget = 'marketplace';
    input.preflight.checks.vsixPair.selected = { ...input.preflight.checks.vsixPair.targets.marketplace, sha256: 'd'.repeat(64) };
    input.preflight.checks.vsixPair.targets.marketplace.sha256 = 'd'.repeat(64);
    input.preflight.checks.vsixPair.pairSha256 = computeVsixPairSha256(input.preflight.checks.vsixPair);
    input.local.candidate.name = 'jsonlview-data-studio';
    input.local.candidate.extensionId = 'Sumi-Sophia.jsonlview-data-studio';
    input.vsix.package.name = 'jsonlview-data-studio';
    const plan = buildPromotionPlan(input);
    expect(plan.readyForPromotion).toBe(true);
    expect(plan.candidate.extensionTarget).toBe('marketplace');
    expect(plan.targets.marketplace.status).toBe('pending-authorization');
    expect(plan.targets.openVsx.status).toBe('not-applicable');
    expect(plan.targets.npm.status).toBe('not-applicable');
  });

  it('rejects stale preflight artifact digests and target-key confusion', () => {
    const input = fixtures();
    input.preflight.checks.vsixCandidate.actualSha256 = 'f'.repeat(64);
    input.preflight.checks.vsixCandidate.target.extensionId = 'Sumi-Sophia.jsonlview-data-studio';
    input.preflight.checks.npmCandidate.tarball.sha256 = 'a'.repeat(64);
    const plan = buildPromotionPlan(input);
    expect(plan.readyForPromotion).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      'VSIX sidecar digest differs from the exact artifact approved by preflight',
      'preflight extension target differs from the canonical release target contract',
      'npm tarball digest differs from the exact artifact approved by preflight',
    ]));
  });

  it('rejects drift in the update-chain contract', () => {
    const input = fixtures();
    input.preflight.checks.vsixCandidate.target.preservesUpdateChain = false;
    const plan = buildPromotionPlan(input);
    expect(plan.readyForPromotion).toBe(false);
    expect(plan.blockers).toContain('preflight extension target differs from the canonical release target contract');
  });

  it('blocks identity and artifact drift instead of silently publishing a different package', () => {
    const input = fixtures();
    input.npm.package.version = '0.1.11';
    input.vsix.artifact.sha256 = 'e'.repeat(64);
    const plan = buildPromotionPlan(input);
    expect(plan.readyForPromotion).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      'version differs between candidate manifests',
      expect.stringContaining('different digests'),
    ]));
  });

  it('rejects a package scope that was not approved by preflight', () => {
    const input = fixtures();
    input.npm.package.name = '@other/jsonl-view';
    const plan = buildPromotionPlan(input);
    expect(plan.readyForPromotion).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      'npm candidate name differs from the preflight approved package identity',
    ]));
  });

  it('rejects canonical npm drift even when candidate and approval drift together', () => {
    const input = fixtures();
    input.npm.package.name = '@other/jsonl-view';
    input.preflight.checks.npmCandidate.approvedName = '@other/jsonl-view';
    const plan = buildPromotionPlan(input);
    expect(plan.readyForPromotion).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      'npm candidate name differs from the canonical release target contract',
      'preflight approved npm name differs from the canonical release target contract',
    ]));
  });

  it('joins only target plans produced from the same VSIX pair', () => {
    const openInput = fixtures();
    const openPlan = buildPromotionPlan(openInput);
    const marketInput = fixtures();
    marketInput.preflight.checks.vsixCandidate.target = {
      key: 'marketplace', registry: 'visual-studio-marketplace', extensionId: 'Sumi-Sophia.jsonlview-data-studio', displayName: 'JsonlView Data Studio', preservesUpdateChain: false,
    };
    marketInput.preflight.checks.vsixPair.selectedTarget = 'marketplace';
    marketInput.preflight.checks.vsixPair.selected = marketInput.preflight.checks.vsixPair.targets.marketplace;
    marketInput.preflight.checks.vsixCandidate.actualSha256 = 'f'.repeat(64);
    marketInput.local.candidate = { ...marketInput.local.candidate, name: 'jsonlview-data-studio', extensionId: 'Sumi-Sophia.jsonlview-data-studio', sha256: 'f'.repeat(64) };
    marketInput.vsix.package.name = 'jsonlview-data-studio';
    marketInput.vsix.artifact.sha256 = 'f'.repeat(64);
    const marketPlan = buildPromotionPlan(marketInput);
    expect(buildPromotionJoin({ openVsx: openPlan, marketplace: marketPlan }).readyForPromotion).toBe(true);

    const incompatible = structuredClone(marketPlan);
    incompatible.candidate.vsixPairSha256 = '9'.repeat(64);
    const joined = buildPromotionJoin({ openVsx: openPlan, marketplace: incompatible });
    expect(joined.readyForPromotion).toBe(false);
    expect(joined.blockers).toContain('promotion plans were produced from different VSIX pairs');
  });

  it('accepts exactly one pnpm separator and rejects a second one', () => {
    expect(parseArgs(['--', '--preflight', 'preflight.json', '--local-manifest', 'local.json', '--vsix-manifest', 'vsix.json', '--npm-manifest', 'npm.json'])).toMatchObject({
      preflight: 'preflight.json',
      localManifest: 'local.json',
    });
    expect(() => parseArgs(['--', '--', '--preflight', 'preflight.json'])).toThrow(/requires a value|unknown argument/i);
  });

  it('keeps the coordinator plan-only so a future edit cannot add implicit publication', async () => {
    const source = await readFile(new URL('../../scripts/promotion-plan.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(?:execFile|spawn|fetch)\b/);
    expect(source).not.toMatch(/(?:npm\s+publish|git\s+push|ovsx\s+publish|vsce\s+publish)/i);
  });
});
