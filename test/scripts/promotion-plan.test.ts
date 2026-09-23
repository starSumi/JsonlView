import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript CLI module intentionally does not emit declarations.
import { buildPromotionPlan, parseArgs } from '../../scripts/promotion-plan.mjs';

const source = {
  gitSha: 'a'.repeat(40),
  gitState: 'clean',
  statusSha256: 'b'.repeat(64),
  diffSha256: 'c'.repeat(64),
};

function fixtures() {
  return {
    preflight: { ok: true, mode: 'public-release', checks: { git: { revision: source.gitSha, gitState: source.gitState, statusSha256: source.statusSha256, diffSha256: source.diffSha256, remoteConfigured: true }, package: { name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', private: false, license: 'MIT', repository: 'github.com/starsumi/jsonlview' }, npmCandidate: { approvedName: '@sumi-labs/jsonl-view', integrity: true, clean: true }, vsixCandidate: { integrity: true }, nativeProvenance: { ok: true, committedBinaryChecked: true, contractEqual: true, behaviorEqual: true } }, failures: [] as Array<{ check: string }> },
    local: { source: { sha: source.gitSha, clean: true, statusSha256: source.statusSha256, diffSha256: source.diffSha256 }, candidate: { name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', sha256: 'd'.repeat(64), extensionId: 'Sumi-Sophia.jsonl-view' }, vscode: { status: 'installed', activeWindowReloaded: true, reloadRequired: false } },
    vsix: { source, package: { name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', private: false, license: 'MIT' }, artifact: { sha256: 'd'.repeat(64) } },
    npm: { source, package: { name: '@sumi-labs/jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', private: false, license: 'MIT' } },
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
    expect(plan.candidate.approvedNpmName).toBe('@sumi-labs/jsonl-view');
  });

  it('blocks a dirty or failed preflight and never upgrades target status', () => {
    const input = fixtures();
    input.preflight = { ok: false, mode: 'public-release', checks: { git: { revision: source.gitSha, gitState: 'dirty', statusSha256: source.statusSha256, diffSha256: source.diffSha256, remoteConfigured: true }, package: { name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.1.10', private: false, license: 'MIT', repository: 'github.com/starsumi/jsonlview' }, npmCandidate: { approvedName: '@sumi-labs/jsonl-view', integrity: true, clean: true }, vsixCandidate: { integrity: true }, nativeProvenance: { ok: true, committedBinaryChecked: true, contractEqual: true, behaviorEqual: true } }, failures: [{ check: 'git.clean' }] };
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
