import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { findForbiddenVsixPaths, findVsixPolicyViolations, isVsixPathAllowed, missingVsixRequiredFiles, normalizeVsixPath, projectArtifactReadme, VSIX_FORBIDDEN_PREFIXES, VSIX_PUBLIC_ASSETS, VSIX_PUBLIC_FILES, VSIX_REQUIRED_FILES } from '../../scripts/vsix-package-policy.mjs';
// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { extractReferencedAssets } from '../../scripts/check-public-surface.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('VSIX package policy', () => {
  it('normalizes staging and extension archive paths to one policy path', () => {
    expect(normalizeVsixPath('extension\\README.md')).toBe('README.md');
    expect(normalizeVsixPath('README.md')).toBe('README.md');
    expect(normalizeVsixPath('/extension/README.md')).toBe('README.md');
    expect(normalizeVsixPath(undefined)).toBeUndefined();
  });

  it('allows only public metadata, runtime payloads, and declared user resources', () => {
    expect(VSIX_PUBLIC_FILES).toEqual(expect.arrayContaining([
      'package.json',
      'README.md',
      'LICENSE.txt',
      'images/jsonlview-icon.png',
      'package.nls.json',
      'docs/format-and-profile-boundaries.md',
    ]));
    expect(isVsixPathAllowed('extension/dist/webview.js')).toBe(true);
    expect(isVsixPathAllowed('extension/native/jsonl-core/jsonl_core.win32-x64-msvc.node')).toBe(true);
    for (const asset of VSIX_PUBLIC_ASSETS) expect(isVsixPathAllowed(`extension/${asset}`)).toBe(true);
    expect(isVsixPathAllowed('extension/docs/assets/unreferenced-private.png')).toBe(false);
    expect(isVsixPathAllowed('extension/docs/decisions/058-vsix-content-staging-policy.md')).toBe(false);
    expect(isVsixPathAllowed('extension/docs/acceleration-roadmap.md')).toBe(false);
    expect(VSIX_REQUIRED_FILES).toEqual(expect.arrayContaining(VSIX_PUBLIC_ASSETS));
  });

  it('limits VSIX document assets to the README public references', async () => {
    const readme = await readFile(resolve(import.meta.dirname, '../../README.md'), 'utf8');
    expect(VSIX_PUBLIC_ASSETS).toEqual(extractReferencedAssets(readme));
  });

  it('projects non-packaged documentation links to a stable source commit', () => {
    const projected = projectArtifactReadme(
      '[Decision](docs/decisions/001.md) and [format](docs/format-and-profile-boundaries.md)',
      {
        repositoryUrl: 'git+https://github.com/starSumi/JsonlView.git',
        commitSha: 'b'.repeat(40),
        allowedPaths: [...VSIX_PUBLIC_FILES, ...VSIX_PUBLIC_ASSETS],
      },
    );

    expect(projected).toBe('[Decision](https://github.com/starSumi/JsonlView/blob/'
      + `${'b'.repeat(40)}/docs/decisions/001.md) and [format](docs/format-and-profile-boundaries.md)`);
  });

  it('rejects source, test, governance, build, and credential paths', () => {
    expect(VSIX_FORBIDDEN_PREFIXES).toEqual(expect.arrayContaining([
      'src/', 'test/', 'scripts/', '.github/', 'report/', 'state/',
    ]));
    const paths = [
      'extension/src/internal.ts',
      'extension/test/fixture.test.ts',
      'extension/scripts/release.mjs',
      'extension/.github/workflows/ci.yml',
      'extension/report/private.md',
      'extension/state/run.json',
      'extension/docs/metadata/index.yaml',
      'extension/native/jsonl-core/Cargo.toml',
      'extension/.env.production',
      'extension/credentials.pem',
      'extension/token-cache.json',
      'extension/fixture.json',
      'extension/session.transcript.json',
    ];
    expect(findForbiddenVsixPaths(paths)).toEqual(expect.arrayContaining([
      'src/internal.ts',
      'test/fixture.test.ts',
      'scripts/release.mjs',
      '.github/workflows/ci.yml',
      'report/private.md',
      'state/run.json',
      'docs/metadata/index.yaml',
      'native/jsonl-core/Cargo.toml',
      '.env.production',
      'credentials.pem',
      'token-cache.json',
      'fixture.json',
      'session.transcript.json',
    ]));
  });

  it('reports missing required public and runtime entries and policy drift', () => {
    expect(missingVsixRequiredFiles(['extension/README.md'])).toEqual(expect.arrayContaining([
      'package.json',
      'dist/webview.js',
      'native/jsonl-core/index.d.ts',
    ]));
    expect(findVsixPolicyViolations([
      'extension/package.json',
      'extension/src/leak.ts',
      'extension/docs/decisions/private.md',
    ])).toEqual(['docs/decisions/private.md', 'src/leak.ts']);
  });
});
