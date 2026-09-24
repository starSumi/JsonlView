import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The release gate is intentionally a JavaScript CLI; keep its pure integrity
// helpers covered without making the production script a TypeScript build input.
// @ts-expect-error release-preflight.mjs has no emitted declaration file.
import { collectSourceProvenanceFailures, compareNativeCandidateDigests, compareNpmCandidateIdentity, comparePackageIdentities, compareSourceProvenance, findForbiddenDistributionPaths, findUnexpectedVsixDistributionPaths, normalizeRepositoryIdentity, validatePackageIdentity, validateSourceProvenance, verifyNpmCandidateIntegrity, verifyVsixArtifactIntegrity } from '../../scripts/release-preflight.mjs';
// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { bundleFromCandidateInventory, bundleInventoryDigest, compareBundleInventories } from '../../scripts/bundle-integrity.mjs';
// @ts-expect-error verify-native-provenance.mjs has no emitted declaration file.
import { validateProvenanceSourceBinding } from '../../scripts/verify-native-provenance.mjs';
// @ts-expect-error vsix-native-integrity.mjs has no emitted declaration file.
import { hashEmbeddedVsixNative, VSIX_NATIVE_ENTRY } from '../../scripts/vsix-native-integrity.mjs';
// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { inventoryEmbeddedVsixBundle } from '../../scripts/vsix-bundle-integrity.mjs';
// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { compareReleaseLegalInventories } from '../../scripts/release-legal-integrity.mjs';
// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { compareVsixArchiveIdentity } from '../../scripts/vsix-archive-integrity.mjs';
// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { resolveNpmInvocation, resolvePnpmInvocation } from '../../scripts/package-manager-invocation.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('release candidate integrity', () => {
  it('validates the staged VSIX identity and rejects development metadata', () => {
    const valid = validatePackageIdentity({
      name: 'jsonl-view',
      publisher: 'Sumi-Sophia',
      version: '0.1.10',
      private: false,
      license: 'MIT',
      repository: { type: 'git', url: 'https://github.com/starSumi/JsonlView.git' },
    }, {
      requireName: true,
      requirePublisher: true,
      requireVersion: true,
      requirePrivate: true,
      requireLicense: true,
      requireRepository: true,
      publicRelease: true,
    });
    expect(valid.ok).toBe(true);
    expect(valid.identity).toMatchObject({
      name: 'jsonl-view',
      publisher: 'Sumi-Sophia',
      version: '0.1.10',
      private: false,
      license: 'MIT',
      repository: 'github.com/starsumi/jsonlview',
    });

    const development = validatePackageIdentity({
      name: 'jsonl-view',
      publisher: 'momo',
      version: '0.1',
      private: true,
      license: 'UNLICENSED',
    }, {
      requireName: true,
      requirePublisher: true,
      requireVersion: true,
      requirePrivate: true,
      requireLicense: true,
      requireRepository: true,
      publicRelease: true,
    });
    expect(development.ok).toBe(false);
    expect(development.issues.map((issue: { field: string }) => issue.field)).toEqual(expect.arrayContaining([
      'publisher', 'version', 'private', 'license', 'repository',
    ]));
  });

  it('compares source provenance and candidate identities instead of trusting the commit alone', () => {
    const source = {
      gitSha: 'a'.repeat(40),
      gitState: 'clean',
      statusSha256: 'b'.repeat(64),
      diffSha256: 'c'.repeat(64),
    };
    expect(validateSourceProvenance(source, {
      revision: 'a'.repeat(40),
      gitState: 'clean',
      statusSha256: 'b'.repeat(64),
      diffSha256: 'c'.repeat(64),
    }).ok).toBe(true);
    expect(validateSourceProvenance({ ...source, statusSha256: 'd'.repeat(64) }, {
      revision: 'a'.repeat(40),
      gitState: 'clean',
      statusSha256: 'b'.repeat(64),
      diffSha256: 'c'.repeat(64),
    }).issues).toEqual(expect.arrayContaining([
      expect.stringContaining('status digest'),
    ]));
    expect(compareSourceProvenance(source, { ...source, diffSha256: 'd'.repeat(64) })).toEqual([
      'diffSha256 differs between candidate manifests',
    ]);
    expect(comparePackageIdentities(
      { name: 'jsonl-view', version: '0.1.10' },
      { name: 'jsonl-view', version: '0.1.9' },
      ['name', 'version'],
    )).toEqual(['version differs between candidate manifests']);
    expect(compareNpmCandidateIdentity(
      { name: 'jsonl-view', version: '0.1.10' },
      { name: '@sumi-labs/jsonl-view', version: '0.1.10' },
    )).toEqual([]);
    expect(compareNpmCandidateIdentity(
      { name: 'jsonl-view', version: '0.1.10' },
      { name: '@other/jsonl-view', version: '0.1.11' },
      '@sumi-labs/jsonl-view',
    )).toEqual([
      'npm candidate name does not match the approved package identity',
      'version differs between VSIX and npm candidates',
    ]);
  });

  it('turns missing or mismatched candidate provenance into release-gate failures', () => {
    const current = {
      revision: 'a'.repeat(40),
      gitState: 'clean',
      statusSha256: 'b'.repeat(64),
      diffSha256: 'c'.repeat(64),
    };
    expect(collectSourceProvenanceFailures(undefined, current, 'vsixCandidate.source', 'vsixCandidate.provenance').failures)
      .toEqual([{ check: 'vsixCandidate.provenance', message: 'vsixCandidate.source is missing' }]);
    const mismatched = collectSourceProvenanceFailures({
      gitSha: 'd'.repeat(40),
      gitState: 'clean',
      statusSha256: 'b'.repeat(64),
      diffSha256: 'c'.repeat(64),
    }, current, 'vsixCandidate.source', 'vsixCandidate.provenance');
    expect(mismatched.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: 'vsixCandidate.provenance', message: expect.stringContaining('commit does not match') }),
    ]));
  });

  it('wires source provenance enforcement into both npm and VSIX candidate gates', async () => {
    const source = await readFile(new URL('../../scripts/release-preflight.mjs', import.meta.url), 'utf8');
    const calls = source.match(/const sourceValidation = requireSourceProvenance\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(source).toContain("'npmCandidate.source', 'npmCandidate.provenance'");
    expect(source).toContain("'vsixCandidate.source', 'vsixCandidate.provenance'");
  });

  it('requires exact license and third-party notice bytes in every public archive', () => {
    const source = [
      inventoryEntry('LICENSE.txt', Buffer.from('MIT license', 'utf8')),
      inventoryEntry('THIRD-PARTY-NOTICES.txt', Buffer.from('notices', 'utf8')),
      inventoryEntry('third_party/licenses/dependency-LICENSE.txt', Buffer.from('dependency license', 'utf8')),
    ];
    expect(compareReleaseLegalInventories(source, source, 'candidate')).toEqual([]);
    expect(compareReleaseLegalInventories(source, source.filter((file) => file.path !== 'LICENSE.txt'), 'candidate'))
      .toEqual(expect.arrayContaining([expect.stringContaining('missing LICENSE.txt')]));
    expect(compareReleaseLegalInventories(source, source.map((file) => file.path === 'THIRD-PARTY-NOTICES.txt'
      ? inventoryEntry(file.path, Buffer.from('tampered', 'utf8'))
      : file), 'candidate'))
      .toEqual(expect.arrayContaining([expect.stringContaining('THIRD-PARTY-NOTICES.txt')]));
  });

  it('rejects private surfaces and files outside the VSIX release allowlist', () => {
    expect(findForbiddenDistributionPaths([
      'extension/.env.local',
      'extension/.npmrc',
      'extension/src/internal.ts',
      'extension/report/private.md',
      'extension/key.p12',
    ], 'extension/')).toHaveLength(5);
    expect(findForbiddenDistributionPaths(['README.md', 'dist/webview.js'])).toEqual([]);
    expect(findUnexpectedVsixDistributionPaths([
      '[Content_Types].xml',
      'extension.vsixmanifest',
      'extension/package.json',
      'extension/readme.md',
      'extension/changelog.md',
      'extension/LICENSE.txt',
      'extension/THIRD-PARTY-NOTICES.txt',
      'extension/third_party/licenses/dependency.txt',
      'extension/private-notes.md',
    ])).toEqual(['extension/private-notes.md']);
  });

  it('binds embedded VSIX package license, privacy, and repository metadata', () => {
    const expected = {
      name: 'jsonl-view', publisher: 'Sumi-Sophia', version: '0.2.0', private: false, license: 'MIT',
      repository: { type: 'git', url: 'https://github.com/starSumi/JsonlView.git' },
    };
    const archive = {
      package: { ...expected, private: true, license: 'UNLICENSED' },
      vsixManifest: { name: expected.name, publisher: expected.publisher, version: expected.version },
    };
    expect(compareVsixArchiveIdentity(archive, expected, 'root package')).toEqual(expect.arrayContaining([
      expect.stringContaining('private'),
      expect.stringContaining('license'),
    ]));
    expect(compareVsixArchiveIdentity({
      package: expected,
      vsixManifest: { name: expected.name, publisher: expected.publisher, version: expected.version },
    }, { ...expected, repository: 'github.com/starsumi/jsonlview' }, 'canonical root package')).toEqual([]);
  });

  it('pins the pnpm setup action to the verified peeled commit', async () => {
    const expected = 'fc06bc1257f339d1d5d8b3a19a8cae5388b55320';
    for (const workflow of ['ci.yml', 'maintenance.yml']) {
      const source = await readFile(new URL(`../../.github/workflows/${workflow}`, import.meta.url), 'utf8');
      const references = [...source.matchAll(/uses:\s*pnpm\/action-setup@([^\s#]+)/g)].map((match) => match[1]);
      expect(references.length).toBeGreaterThan(0);
      expect(references.every((reference) => reference === expected)).toBe(true);
    }
  });

  it('keeps scheduled maintenance evidence outside the source checkout', async () => {
    const source = await readFile(new URL('../../.github/workflows/maintenance.yml', import.meta.url), 'utf8');
    expect(source).toContain('${{ runner.temp }}/jsonlview-maintenance');
    expect(source).toContain('${{ runner.temp }}/jsonlview-benchmarks');
    expect(source).not.toContain('.maintenance-artifacts');
  });

  it('runs the locked native CLI directly and fails the Windows job at the source', async () => {
    const buildScript = await readFile(new URL('../../scripts/build-native.mjs', import.meta.url), 'utf8');
    const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(buildScript).toContain("require.resolve('@napi-rs/cli/package.json')");
    expect(buildScript).toContain('spawn(process.execPath');
    expect(buildScript).not.toContain("spawn('pnpm.exe'");
    expect(workflow).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
    expect(workflow).toContain("-PathType Leaf");
    const rebuildStep = workflow.slice(workflow.indexOf('- name: Rebuild native addon from Rust source'));
    expect(rebuildStep.indexOf('pnpm native:build')).toBeLessThan(rebuildStep.indexOf('pnpm build'));
  });

  it('resolves package-manager CLIs without relying on Windows command shims', () => {
    const npm = resolveNpmInvocation();
    const pnpm = resolvePnpmInvocation();
    expect(npm.command).toBe(process.execPath);
    expect(npm.prefix[0]).toMatch(/npm-cli\.js$/i);
    expect(pnpm.command.toLowerCase()).not.toMatch(/\.cmd$/);
  });

  it('normalizes HTTPS and SSH remotes to one repository identity', () => {
    expect(normalizeRepositoryIdentity('https://github.com/starSumi/JsonlView.git')).toBe('github.com/starsumi/jsonlview');
    expect(normalizeRepositoryIdentity('git@github.com:starSumi/JsonlView.git')).toBe('github.com/starsumi/jsonlview');
    expect(normalizeRepositoryIdentity('https://user:secret@github.com/starSumi/JsonlView.git')).toBeUndefined();
  });

  it('matches a nested npm candidate against its frozen inventory', async () => {
    const directory = await createTemporaryDirectory();
    await mkdir(join(directory, 'native'), { recursive: true });
    const packageBytes = Buffer.from('{"name":"candidate"}\n', 'utf8');
    const nativeBytes = Buffer.from('native-addon', 'utf8');
    await writeFile(join(directory, 'package.json'), packageBytes);
    await writeFile(join(directory, 'native', 'addon.node'), nativeBytes);

    const result = await verifyNpmCandidateIntegrity(directory, [
      inventoryEntry('package.json', packageBytes),
      inventoryEntry('native/addon.node', nativeBytes),
    ]);

    expect(result.ok).toBe(true);
    expect(result.expectedFiles).toBe(2);
    expect(result.actualFiles).toBe(2);
    expect(result.issues).toEqual([]);
  });

  it('rejects modified and unexpected npm candidate files', async () => {
    const directory = await createTemporaryDirectory();
    const original = Buffer.from('original', 'utf8');
    await writeFile(join(directory, 'README.md'), Buffer.from('changed!', 'utf8'));
    await writeFile(join(directory, 'extra.txt'), Buffer.from('unexpected', 'utf8'));

    const result = await verifyNpmCandidateIntegrity(directory, [inventoryEntry('README.md', original)]);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      { kind: 'digest-mismatch', path: 'README.md' },
      { kind: 'unexpected-file', path: 'extra.txt' },
    ]));
  });

  it('rejects unsafe or malformed manifest inventory entries', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(join(directory, 'safe.txt'), 'safe', 'utf8');

    const result = await verifyNpmCandidateIntegrity(directory, [
      { path: '../outside.txt', bytes: 1, sha256: '0'.repeat(64) },
      { path: 'safe.txt', bytes: 4, sha256: 'not-a-digest' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      { kind: 'invalid-inventory-entry', path: '../outside.txt' },
      { kind: 'invalid-inventory-entry', path: 'safe.txt' },
    ]));
  });

  it('rechecks both byte length and digest for a VSIX artifact', async () => {
    const directory = await createTemporaryDirectory();
    const bytes = Buffer.from('VSIX payload', 'utf8');
    const artifact = join(directory, 'jsonl-view.vsix');
    await writeFile(artifact, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    await expect(verifyVsixArtifactIntegrity(artifact, { bytes: bytes.length, sha256 })).resolves.toMatchObject({ ok: true });
    await writeFile(artifact, Buffer.from('tampered!', 'utf8'));
    const result = await verifyVsixArtifactIntegrity(artifact, { bytes: bytes.length, sha256 });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([{ kind: 'digest-mismatch', path: '<artifact>' }]));
  });

  it('rejects native substitution between provenance and either distributable', () => {
    const approved = 'a'.repeat(64);
    expect(compareNativeCandidateDigests({
      provenance: approved,
      npmManifest: approved,
      npmInventory: approved,
      vsixManifest: approved,
      vsixArchive: approved,
    })).toEqual([]);
    expect(compareNativeCandidateDigests({
      provenance: approved,
      npmManifest: 'b'.repeat(64),
      vsixArchive: approved,
    })).toEqual([expect.stringContaining('digests differ')]);
    expect(compareNativeCandidateDigests({
      provenance: approved,
      vsixArchive: undefined,
    })).toEqual([expect.stringContaining('vsixArchive')]);
  });

  it('rejects npm and VSIX candidates built from different production bundles', () => {
    const npmFiles = ['extension.cjs', 'webview.css', 'webview.js'].map((path, index) => ({
      path,
      bytes: index + 1,
      sha256: String(index + 1).repeat(64),
    }));
    const vsixFiles = npmFiles.map((file) => ({ ...file }));
    vsixFiles[0] = { ...vsixFiles[0]!, sha256: 'f'.repeat(64) };
    const npmBundle = { files: npmFiles, bytes: 6, sha256: bundleInventoryDigest(npmFiles) };
    const vsixBundle = { files: vsixFiles, bytes: 6, sha256: bundleInventoryDigest(vsixFiles) };

    expect(compareBundleInventories(npmBundle, npmBundle)).toEqual([]);
    expect(compareBundleInventories(npmBundle, vsixBundle)).toContain('bundle inventory digests differ');
    expect(compareBundleInventories(undefined, npmBundle)).toContain('bundle inventory 1 is missing');
    expect(bundleFromCandidateInventory(npmFiles.map((file) => ({ ...file, path: `dist/${file.path}` })))).toEqual(npmBundle);
    expect(bundleFromCandidateInventory([
      ...npmFiles.map((file) => ({ ...file, path: `dist/${file.path}` })),
      { path: 'dist/injected.js', bytes: 1, sha256: 'a'.repeat(64) },
    ])).toBeUndefined();
  });

  it('binds native provenance to the current HEAD and native source digest', () => {
    const gitSha = 'a'.repeat(40);
    const sourceDigest = 'b'.repeat(64);
    const report = {
      repository: { gitSha },
      source: { sha256: sourceDigest },
      comparison: { sourceDigest },
    };

    expect(validateProvenanceSourceBinding(report, { gitSha, sourceDigest })).toMatchObject({
      ok: true,
      repositoryHeadMatchesCurrent: true,
      sourceDigestMatchesCurrent: true,
      sourceManifestMatchesReport: true,
    });
    expect(validateProvenanceSourceBinding(report, { gitSha: 'c'.repeat(40), sourceDigest })).toMatchObject({
      ok: false,
      repositoryHeadMatchesCurrent: false,
    });
    expect(validateProvenanceSourceBinding(report, { gitSha, sourceDigest: 'd'.repeat(64) })).toMatchObject({
      ok: false,
      sourceDigestMatchesCurrent: false,
    });
    expect(validateProvenanceSourceBinding({
      ...report,
      source: { sha256: 'e'.repeat(64) },
    }, { gitSha, sourceDigest })).toMatchObject({
      ok: false,
      sourceManifestMatchesReport: false,
    });
  });

  it('scans the complete VSIX central directory and rejects duplicate native entries', async () => {
    const directory = await createTemporaryDirectory();
    const artifact = join(directory, 'duplicate-native.vsix');
    await writeFile(artifact, createStoredZip([
      { name: VSIX_NATIVE_ENTRY, contents: Buffer.from('approved-native', 'utf8') },
      { name: 'extension/readme.md', contents: Buffer.from('keep scanning', 'utf8') },
      { name: VSIX_NATIVE_ENTRY, contents: Buffer.from('substituted-native', 'utf8') },
    ]));

    await expect(hashEmbeddedVsixNative(artifact)).rejects.toThrow(/duplicate/i);
  });

  it('rejects missing, duplicate, and unexpected VSIX production bundle entries', async () => {
    const directory = await createTemporaryDirectory();
    const validEntries = [
      { name: 'extension/dist/extension.cjs', contents: Buffer.from('extension', 'utf8') },
      { name: 'extension/dist/webview.css', contents: Buffer.from('css', 'utf8') },
      { name: 'extension/dist/webview.js', contents: Buffer.from('webview', 'utf8') },
    ];
    const valid = join(directory, 'valid-bundle.vsix');
    await writeFile(valid, createStoredZip(validEntries));
    await expect(inventoryEmbeddedVsixBundle(valid)).resolves.toMatchObject({ files: expect.any(Array) });

    const duplicate = join(directory, 'duplicate-bundle.vsix');
    await writeFile(duplicate, createStoredZip([...validEntries, validEntries[2]!]));
    await expect(inventoryEmbeddedVsixBundle(duplicate)).rejects.toThrow(/duplicate/i);

    const unexpected = join(directory, 'unexpected-bundle.vsix');
    await writeFile(unexpected, createStoredZip([
      ...validEntries,
      { name: 'extension/dist/injected.js', contents: Buffer.from('injected', 'utf8') },
    ]));
    await expect(inventoryEmbeddedVsixBundle(unexpected)).rejects.toThrow(/unexpected/i);

    const missing = join(directory, 'missing-bundle.vsix');
    await writeFile(missing, createStoredZip(validEntries.slice(0, 2)));
    await expect(inventoryEmbeddedVsixBundle(missing)).rejects.toThrow(/missing/i);
  });
});

function inventoryEntry(path: string, bytes: Buffer): { path: string; bytes: number; sha256: string } {
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-release-preflight-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createStoredZip(entries: Array<{ name: string; contents: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.contents.length, 18);
    local.writeUInt32LE(entry.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.contents.length, 20);
    central.writeUInt32LE(entry.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
