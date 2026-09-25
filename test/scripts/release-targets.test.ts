import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { loadReleaseTargets, validateReleaseTargets } from '../../scripts/release-targets.mjs';
// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { verifyVsixTargetEvidence } from '../../scripts/verify-vsix-targets.mjs';
// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { booleanOrNull } from '../../scripts/prepare-npm-package.mjs';

const sharedFiles = [
  { path: 'extension/dist/extension.cjs', bytes: 10, sha256: '1'.repeat(64) },
  { path: 'extension/native/jsonl-core/jsonl_core.win32-x64-msvc.node', bytes: 11, sha256: '2'.repeat(64) },
  { path: 'extension/package.json', bytes: 12, sha256: '3'.repeat(64) },
  { path: 'extension.vsixmanifest', bytes: 13, sha256: '4'.repeat(64) },
];

function archive(
  name: string,
  displayName: string,
  files = sharedFiles,
  packageOverrides: Record<string, unknown> = {},
  manifestSuffix = '',
) {
  const packageJson = {
    name,
    displayName,
    publisher: 'Sumi-Sophia',
    version: '0.2.1',
    main: './dist/extension.cjs',
    engines: { vscode: '^1.136.0' },
    contributes: { commands: [{ command: 'jsonlView.open' }] },
    ...packageOverrides,
  };
  return {
    identity: { package: { name, displayName, publisher: 'Sumi-Sophia', version: '0.2.1' } },
    artifact: { sha256: '5'.repeat(64) },
    native: { sha256: '2'.repeat(64) },
    bundle: { sha256: '1'.repeat(64) },
    files,
    metadata: {
      packageJson: JSON.stringify(packageJson),
      vsixManifest: `<PackageManifest><Metadata><Identity Language="en-US" Id="${name}" Version="0.2.1" Publisher="Sumi-Sophia" /><DisplayName>${displayName}</DisplayName><Categories>Other</Categories>${manifestSuffix}</Metadata></PackageManifest>`,
    },
  };
}

describe('release target contract', () => {
  it('loads distinct registry coordinates and preserves the Open VSX update identity', async () => {
    const contract = await loadReleaseTargets();
    expect(validateReleaseTargets(contract)).toEqual([]);
    expect(contract.extensions['open-vsx']).toMatchObject({ name: 'jsonl-view', preservesUpdateChain: true });
    expect(contract.extensions.marketplace).toMatchObject({ name: 'jsonlview-data-studio', preservesUpdateChain: false });
    expect(contract.coInstallSupported).toBe(false);
    expect(validateReleaseTargets({
      ...contract,
      extensions: {
        ...contract.extensions,
        'open-vsx': { ...contract.extensions['open-vsx'], registry: 'visual-studio-marketplace' },
      },
    })).toContain('extensions.open-vsx.registry must be open-vsx');
  });

  it('rejects metadata drift outside the two permitted identity fields', async () => {
    const contract = await loadReleaseTargets();
    const packageDrift = verifyVsixTargetEvidence({
      openVsx: archive('jsonl-view', 'JsonlView'),
      marketplace: archive('jsonlview-data-studio', 'JsonlView Data Studio', sharedFiles, { main: './dist/other.cjs' }),
    }, {
      openVsxTarget: { key: 'open-vsx', ...contract.extensions['open-vsx'] },
      marketplaceTarget: { key: 'marketplace', ...contract.extensions.marketplace },
    });
    expect(packageDrift.failures).toContain('extension/package.json differs outside allowed registry identity fields');

    const manifestDrift = verifyVsixTargetEvidence({
      openVsx: archive('jsonl-view', 'JsonlView'),
      marketplace: archive('jsonlview-data-studio', 'JsonlView Data Studio', sharedFiles, {}, '<Extra>drift</Extra>'),
    }, {
      openVsxTarget: { key: 'open-vsx', ...contract.extensions['open-vsx'] },
      marketplaceTarget: { key: 'marketplace', ...contract.extensions.marketplace },
    });
    expect(manifestDrift.failures).toContain('extension.vsixmanifest differs outside allowed registry identity fields');
  });

  it('accepts target VSIX files only when all non-identity entries match', async () => {
    const contract = await loadReleaseTargets();
    const result = verifyVsixTargetEvidence({
      openVsx: archive('jsonl-view', 'JsonlView'),
      marketplace: archive('jsonlview-data-studio', 'JsonlView Data Studio'),
    }, {
      openVsxTarget: { key: 'open-vsx', ...contract.extensions['open-vsx'] },
      marketplaceTarget: { key: 'marketplace', ...contract.extensions.marketplace },
    });
    expect(result).toMatchObject({ ok: true, failures: [] });
  });

  it('rejects shared payload drift and incorrect target identity', async () => {
    const contract = await loadReleaseTargets();
    const drifted = sharedFiles.map((file) => file.path.endsWith('extension.cjs')
      ? { ...file, sha256: 'f'.repeat(64) }
      : file);
    const result = verifyVsixTargetEvidence({
      openVsx: archive('jsonl-view', 'JsonlView'),
      marketplace: archive('jsonl-view', 'JsonlView Data Studio', drifted),
    }, {
      openVsxTarget: { key: 'open-vsx', ...contract.extensions['open-vsx'] },
      marketplaceTarget: { key: 'marketplace', ...contract.extensions.marketplace },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'Marketplace extension name differs from the release target contract',
      'non-identity archive entry differs between targets: extension/dist/extension.cjs',
    ]));
  });

  it('keeps unperformed native comparisons distinct from false comparisons', () => {
    expect(booleanOrNull(undefined)).toBeNull();
    expect(booleanOrNull(false)).toBe(false);
    expect(booleanOrNull(true)).toBe(true);
  });
});
