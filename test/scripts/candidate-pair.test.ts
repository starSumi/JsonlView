// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { verifyCandidatePairEvidence } from '../../scripts/verify-candidate-pair.mjs';

// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { bundleInventoryDigest } from '../../scripts/bundle-integrity.mjs';
import { describe, expect, it } from 'vitest';

const distFiles = [
  { path: 'extension.cjs', bytes: 10, sha256: '1'.repeat(64) },
  { path: 'webview.css', bytes: 11, sha256: '2'.repeat(64) },
  { path: 'webview.js', bytes: 12, sha256: '3'.repeat(64) },
];
const nativeSha256 = '4'.repeat(64);

function evidence(native = nativeSha256) {
  return {
    npm: {
      artifact: { bytes: 100, sha256: '5'.repeat(64) },
      packageJson: {
        name: '@sumi-labs/jsonl-view',
        publisher: 'Sumi-Sophia',
        version: '0.2.1',
      },
      files: [
        ...distFiles.map((file) => ({ ...file, path: `dist/${file.path}` })),
        { path: 'native/jsonl-core/jsonl_core.win32-x64-msvc.node', bytes: 13, sha256: nativeSha256 },
      ],
    },
    vsix: {
      artifact: { bytes: 200, sha256: '6'.repeat(64) },
      identity: {
        package: { name: 'jsonlview-data-studio', publisher: 'Sumi-Sophia', version: '0.2.1' },
      },
      native: { sha256: native },
      bundle: {
        files: distFiles,
        bytes: 33,
        sha256: bundleInventoryDigest(distFiles),
      },
    },
  };
}

describe('paired release candidate verification', () => {
  it('accepts independently named npm and extension identities with matching payloads', () => {
    expect(verifyCandidatePairEvidence(evidence(), {
      expectedNpmName: '@sumi-labs/jsonl-view',
      expectedExtensionName: 'jsonlview-data-studio',
      expectedPublisher: 'Sumi-Sophia',
      expectedVersion: '0.2.1',
    })).toMatchObject({ ok: true, failures: [] });
  });

  it('rejects a VSIX built for the wrong registry target', () => {
    const result = verifyCandidatePairEvidence(evidence(), {
      expectedNpmName: '@sumi-labs/jsonl-view',
      expectedExtensionName: 'jsonl-view',
      expectedPublisher: 'Sumi-Sophia',
      expectedVersion: '0.2.1',
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('VSIX extension name differs from the expected release target');
  });

  it('rejects independently rebuilt native bytes', () => {
    const result = verifyCandidatePairEvidence(evidence('7'.repeat(64)));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('native addon differs between npm and VSIX');
  });

  it('rejects a bundle or identity mismatch', () => {
    const input = evidence();
    input.vsix.identity.package.publisher = 'Someone-Else';
    const first = input.vsix.bundle.files[0]!;
    input.vsix.bundle.files[0] = { path: first.path, bytes: first.bytes, sha256: '8'.repeat(64) };
    input.vsix.bundle.sha256 = bundleInventoryDigest(input.vsix.bundle.files);
    const result = verifyCandidatePairEvidence(input, { expectedPublisher: 'Sumi-Sophia' });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'publisher differs between npm and VSIX',
      'VSIX publisher differs from the expected release identity',
      'bundle inventory digests differ',
    ]));
  });
});
