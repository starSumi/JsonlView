import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { assertReportOutput, buildGalleryStatus, buildTarget, finish, galleryReadbackStatus, parseArgs, planReady, postPublishReadback, publishWithReservation, validateArchive, validatePreflight, validateProvenance } from '../../scripts/marketplace-publish.mjs';
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

async function withExternalDirectory(check: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-marketplace-output-'));
  try {
    await check(root);
  } finally {
    const relativeRoot = relative(resolve(tmpdir()), await realpath(root));
    if (!relativeRoot || relativeRoot.startsWith('..') || isAbsolute(relativeRoot)) {
      throw new Error('Refusing to remove an unexpected report test directory');
    }
    await rm(root, { recursive: true });
  }
}

async function failedReport(output: string, inputs: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const previousExitCode = process.exitCode;
  try {
    return await finish({ writeAttempted: true }, 'ambiguous', [], output, inputs);
  } finally {
    process.exitCode = previousExitCode;
    log.mockRestore();
  }
}

describe('Marketplace publication adapter', () => {
  it('defaults to a read-only plan and rejects command-line PATs', () => {
    expect(parseArgs(['--vsix', 'candidate.vsix'])).toMatchObject({ mode: 'plan', vsix: 'candidate.vsix', publisher: 'Sumi-Sophia', extensionName: 'jsonlview-data-studio' });
    expect(() => parseArgs(['--vsix', 'candidate.vsix', '--pat', 'secret'])).toThrow(/VSCE_PAT/);
    expect(() => parseArgs(['--vsix', 'candidate.vsix', '--extension-name', 'jsonl-view'])).toThrow(/pinned/);
    expect(() => parseArgs(['--vsix', 'candidate.vsix', '--publisher', 'other'])).toThrow(/pinned/);
    expect(validateArchive(archive, buildTarget('Sumi-Sophia', 'jsonl-view', '0.2.2'))).toContain('Marketplace target differs from pinned release identity');
    expect(parseArgs(['--', '--vsix', 'candidate.vsix'])).toMatchObject({ vsix: 'candidate.vsix' });
    expect(() => parseArgs(['--', '--', '--vsix', 'candidate.vsix'])).toThrow(/Unexpected argument separator/);
  });

  it('requires the exact target confirmation and release evidence for writes', () => {
    expect(parseArgs(['--publish', '--vsix', 'candidate.vsix', '--provenance', 'candidate.json', '--preflight', 'preflight.json', '--confirm-target', target.confirmation, '--out', 'new-report.json'])).toMatchObject({
      mode: 'publish',
      confirmTarget: target.confirmation,
    });
    expect(() => parseArgs(['--publish', '--vsix', 'candidate.vsix'])).toThrow(/provenance and --preflight/);
    expect(() => parseArgs(['--publish', '--vsix', 'candidate.vsix', '--provenance', 'candidate.json', '--preflight', 'preflight.json'])).toThrow(/requires --out/);
  });

  it('rejects stale Marketplace identity environment overrides', () => {
    vi.stubEnv('JSONLVIEW_MARKETPLACE_EXTENSION_NAME', 'jsonl-view');
    try {
      expect(() => parseArgs(['--vsix', 'candidate.vsix'])).toThrow(/cannot override the pinned Marketplace identity/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('requires official Gallery readback for writes despite environment overrides', () => {
    const publishArgs = ['--publish', '--vsix', 'candidate.vsix', '--provenance', 'candidate.json', '--preflight', 'preflight.json', '--out', 'new-report.json'];
    expect(() => parseArgs([...publishArgs, '--marketplace-url', 'https://example.invalid'])).toThrow(/official Marketplace URL/);
    expect(parseArgs([...publishArgs, '--marketplace-url', 'https://marketplace.visualstudio.com/'])).toMatchObject({ mode: 'publish' });
    expect(parseArgs(['--vsix', 'candidate.vsix', '--marketplace-url', 'https://example.invalid'])).toMatchObject({ mode: 'plan' });
    vi.stubEnv('VSCE_MARKETPLACE_URL', 'http://127.0.0.1:9337');
    try {
      expect(() => parseArgs(publishArgs)).toThrow(/official Marketplace URL/);
      expect(() => parseArgs([...publishArgs, '--marketplace-url', 'https://marketplace.visualstudio.com'])).toThrow(/VSCE_MARKETPLACE_URL/);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv('VSCE_MARKETPLACE_URL', 'https://marketplace.visualstudio.com/');
    try {
      expect(parseArgs(publishArgs)).toMatchObject({ mode: 'publish' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not mark a diagnostic plan or version-only readback as release complete', () => {
    const officialPlan = parseArgs(['--vsix', 'candidate.vsix', '--provenance', 'candidate.json', '--preflight', 'preflight.json']);
    expect(planReady(officialPlan)).toBe(true);
    expect(planReady(parseArgs(['--vsix', 'candidate.vsix']))).toBe(false);
    expect(planReady(parseArgs(['--vsix', 'candidate.vsix', '--provenance', 'candidate.json', '--preflight', 'preflight.json', '--marketplace-url', 'https://example.invalid']))).toBe(false);
    expect(galleryReadbackStatus(true)).toBe('version-visible-unverified');
    expect(galleryReadbackStatus(false)).toBe('ambiguous');
  });

  it('retains an attempted and returned write when public readback fails', async () => {
    const report = { target, writeAttempted: true, writeReturned: true };
    const readback = await postPublishReadback(report, {
      marketplaceUrl: 'https://marketplace.visualstudio.com',
      timeoutMs: 5_000,
      intervalMs: 1_000,
    }, async () => { throw new Error('Gallery unavailable'); });

    expect(readback).toMatchObject({ status: 'ambiguous', issues: [expect.stringContaining('Do not retry')] });
    expect(report).toMatchObject({ writeAttempted: true, writeReturned: true, galleryReadbackError: { message: 'Gallery unavailable' } });
  });

  it('prints an attempted write even when the external report cannot be saved', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    try {
      const result = await finish({ writeAttempted: true, writeReturned: true }, 'ambiguous', [], tmpdir());
      expect(result).toMatchObject({ ok: false, writeAttempted: true, writeReturned: true, reportWriteError: { name: 'Error' } });
      expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('do not retry')]));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"writeAttempted": true'));
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
    }
  });

  it('rejects report output overlapping each evidence input without changing it', async () => {
    await withExternalDirectory(async (root) => {
      const inputs = [join(root, 'candidate.vsix'), join(root, 'provenance.json'), join(root, 'preflight.json')];
      for (const input of inputs) await writeFile(input, 'original evidence');
      for (const input of inputs) {
        await expect(assertReportOutput(input, inputs)).rejects.toThrow(/cannot overlap/);
        const result = await failedReport(input, inputs);
        expect(result.reportWriteError?.message).toMatch(/cannot overlap/);
        expect(await readFile(input, 'utf8')).toBe('original evidence');
      }
      await expect(assertReportOutput(join(root, 'nested', 'report.json'), [root])).rejects.toThrow(/cannot overlap/);
    });
  });

  it('never overwrites an existing report file', async () => {
    await withExternalDirectory(async (root) => {
      const output = join(root, 'report.json');
      await writeFile(output, 'original report');
      const result = await failedReport(output, []);
      expect(result.reportWriteError?.name).toBe('Error');
      expect(await readFile(output, 'utf8')).toBe('original report');
    });
  });

  it('persists an exclusive attempted-write record before calling the publisher', async () => {
    await withExternalDirectory(async (root) => {
      const output = join(root, 'report.json');
      const report = { target, writeAttempted: false };
      const publish = vi.fn(async () => {
        expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
          status: 'write-outcome-unknown', writeAttempted: true, ok: false,
        });
      });
      const result = await publishWithReservation('candidate.vsix', 'test-token', output, [], report, publish);
      expect(publish).toHaveBeenCalledOnce();
      expect(report.writeAttempted).toBe(true);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const previousExitCode = process.exitCode;
      try {
        await finish(report, 'ambiguous', ['Readback not verified'], output, [], result.reportHandle);
        expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
          status: 'ambiguous', writeAttempted: true, issues: ['Readback not verified'],
        });
      } finally {
        process.exitCode = previousExitCode;
        log.mockRestore();
      }
    });
  });

  it('does not call the publisher when the report cannot be reserved', async () => {
    await withExternalDirectory(async (root) => {
      const output = join(root, 'report.json');
      await writeFile(output, 'previous evidence');
      const publish = vi.fn();
      await expect(publishWithReservation('candidate.vsix', 'test-token', output, [], { target }, publish)).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
      expect(await readFile(output, 'utf8')).toBe('previous evidence');
    });
  });

  it('rejects a report path through a link or junction into the product checkout', async (context) => {
    await withExternalDirectory(async (root) => {
      const checkout = fileURLToPath(new URL('../..', import.meta.url));
      const linkPath = join(root, 'product-link');
      try {
        await symlink(checkout, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
          && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
          context.skip();
          return;
        }
        throw error;
      }
      const output = join(linkPath, 'blocked-report.json');
      await expect(assertReportOutput(output)).rejects.toThrow(/symbolic-link or junction/);
      const result = await failedReport(output, []);
      expect(result.reportWriteError?.message).toMatch(/symbolic-link or junction/);
    });
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
