import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { buildGalleryStatus, buildTarget, parseArgs, validatePreflight, validateProvenance } from '../../scripts/marketplace-publish.mjs';
// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { buildGalleryRequest, normalizeMarketplaceUrl, pollGalleryVersion } from '../../scripts/marketplace-gallery.mjs';

const target = buildTarget('Sumi-Sophia', 'jsonlview-data-studio', '0.2.2');
const archive = {
  artifact: { bytes: 123, sha256: 'a'.repeat(64) },
  identity: {
    package: { name: target.extensionName, publisher: target.publisher, version: target.version },
    vsixManifest: { name: target.extensionName, publisher: target.publisher, version: target.version },
  },
};

describe('Marketplace publication adapter', () => {
  it('defaults to a read-only plan and rejects command-line PATs', () => {
    expect(parseArgs(['--vsix', 'candidate.vsix'])).toMatchObject({ mode: 'plan', vsix: 'candidate.vsix' });
    expect(() => parseArgs(['--vsix', 'candidate.vsix', '--pat', 'secret'])).toThrow(/VSCE_PAT/);
  });

  it('requires the exact target confirmation and release evidence for writes', () => {
    expect(parseArgs(['--publish', '--vsix', 'candidate.vsix', '--provenance', 'candidate.json', '--preflight', 'preflight.json', '--confirm-target', target.confirmation])).toMatchObject({
      mode: 'publish',
      confirmTarget: target.confirmation,
    });
    expect(() => parseArgs(['--publish', '--vsix', 'candidate.vsix'])).toThrow(/provenance and --preflight/);
  });

  it('constructs the official name-filtered gallery query', () => {
    const request = buildGalleryRequest(target.publisher, target.extensionName);
    expect(request.body.filters[0].criteria).toEqual([{ filterType: 7, value: target.extensionId }]);
    expect(request.body.flags).toBe(1);
    expect(normalizeMarketplaceUrl('https://marketplace.visualstudio.com/')).toBe('https://marketplace.visualstudio.com');
  });

  it('keeps gallery version readback separate from artifact digest proof', () => {
    expect(buildGalleryStatus({ extensionFound: true, versions: ['0.2.1', '0.2.2'] }, '0.2.2')).toMatchObject({ versionPresent: true });
    expect(validateProvenance({ artifact: archive.artifact, archiveIdentity: archive.identity, releaseTarget: { extensionId: target.extensionId } }, archive, target)).toEqual([]);
  });

  it('derives the requested version at the gallery readback boundary', async () => {
    const result = await pollGalleryVersion({
      marketplaceUrl: 'https://marketplace.visualstudio.com',
      publisher: target.publisher,
      name: target.extensionName,
      version: target.version,
      timeoutMs: 5_000,
      intervalMs: 1_000,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            results: [{
              extensions: [{
                extensionName: target.extensionName,
                publisher: { publisherName: target.publisher },
                versions: [{ version: target.version }],
              }],
            }],
          };
        },
      }),
    });
    expect(result).toMatchObject({ extensionFound: true, versionPresent: true, versions: [target.version] });
  });

  it('blocks stale or differently targeted preflight evidence', () => {
    const preflight = { mode: 'public-release', ok: true, checks: { vsixCandidate: { integrity: true, actualSha256: 'b'.repeat(64), actualBytes: 123, target: { extensionId: 'Sumi-Sophia.other' } } } };
    expect(validatePreflight(preflight, archive, target)).toEqual(expect.arrayContaining([
      'preflight VSIX SHA-256 differs from the exact VSIX',
      'preflight target differs from the Marketplace extension ID',
    ]));
  });
});
