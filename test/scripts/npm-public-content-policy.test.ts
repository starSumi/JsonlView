import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript release helper intentionally has no emitted declaration file.
import { NPM_PUBLIC_ASSETS, NPM_PUBLIC_DOCUMENTS, NPM_PUBLIC_FILES } from '../../scripts/prepare-npm-package.mjs';
// @ts-expect-error JavaScript release helper intentionally has no emitted declaration file.
import { projectArtifactReadme } from '../../scripts/vsix-package-policy.mjs';
// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { extractReferencedAssets } from '../../scripts/check-public-surface.mjs';

describe('npm public content policy', () => {
  it('includes only the user-facing format document and README-referenced assets', async () => {
    const readme = await readFile(resolve(import.meta.dirname, '../../README.md'), 'utf8');
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { files: string[] };
    const expectedAssets = extractReferencedAssets(readme);

    expect(NPM_PUBLIC_DOCUMENTS).toEqual(['docs/format-and-profile-boundaries.md']);
    expect(NPM_PUBLIC_ASSETS).toEqual(expectedAssets);
    expect(NPM_PUBLIC_FILES.filter((path: string) => path.startsWith('docs/'))).toEqual([
      ...NPM_PUBLIC_DOCUMENTS,
      ...NPM_PUBLIC_ASSETS,
    ]);
    expect(manifest.files.filter((path) => path.startsWith('docs/'))).toEqual([
      ...NPM_PUBLIC_DOCUMENTS,
      ...NPM_PUBLIC_ASSETS,
    ]);
    expect(NPM_PUBLIC_FILES).not.toContain('docs/decisions');
    expect(NPM_PUBLIC_FILES).not.toContain('docs/assets');
    expect(manifest.files).not.toContain('docs/metadata');
    expect(manifest.files).not.toContain('docs/roadmap.yaml');
  });

  it('keeps retained README links local and projects excluded docs to the pinned repository commit', async () => {
    const readme = await readFile(resolve(import.meta.dirname, '../../README.md'), 'utf8');
    const projected = projectArtifactReadme(readme, {
      repositoryUrl: 'https://github.com/starSumi/JsonlView.git',
      commitSha: 'a'.repeat(40),
      allowedPaths: NPM_PUBLIC_FILES.filter((path: string) => path.startsWith('docs/')),
    });

    expect(projected).toContain('[format and profile boundaries](docs/format-and-profile-boundaries.md)');
    expect(projected).toContain('](docs/assets/codex-timeline-exec.png)');
    expect(projected).toContain('[ADR-072](https://github.com/starSumi/JsonlView/blob/'
      + `${'a'.repeat(40)}/docs/decisions/072-scoped-raw-export-recovery.md)`);
    expect(projected).toContain('[Acceleration roadmap](https://github.com/starSumi/JsonlView/blob/'
      + `${'a'.repeat(40)}/docs/acceleration-roadmap.md)`);
    expect(projected).not.toMatch(/\]\(docs\/(?:decisions|metadata|reliability|security)\//u);
    const localDocumentationTargets = [...projected.matchAll(/\]\((docs\/[^)\s]+)/gu)].map((match) => match[1]);
    expect(localDocumentationTargets.length).toBeGreaterThan(0);
    expect(localDocumentationTargets.every((target) => NPM_PUBLIC_FILES.includes(target))).toBe(true);
  });

  it('fails closed when an excluded README image or unstable repository identity cannot be projected', () => {
    const allowedPaths = ['docs/format-and-profile-boundaries.md'];
    expect(() => projectArtifactReadme('![private](docs/assets/private.png)', {
      repositoryUrl: 'https://github.com/starSumi/JsonlView',
      commitSha: 'a'.repeat(40),
      allowedPaths,
    })).toThrow(/image outside the artifact allowlist/u);
    expect(() => projectArtifactReadme('[decision](docs/decisions/001.md)', {
      repositoryUrl: 'https://example.com/JsonlView',
      commitSha: 'a'.repeat(40),
      allowedPaths,
    })).toThrow(/HTTPS GitHub/u);
    expect(() => projectArtifactReadme('[decision](docs/decisions/001.md)', {
      repositoryUrl: 'https://github.com/starSumi/JsonlView',
      commitSha: 'short-sha',
      allowedPaths,
    })).toThrow(/40-character source commit SHA/u);
  });

  it('keeps VS Code packaging scoped to the same docs and image allowlist', async () => {
    const ignore = await readFile(resolve(import.meta.dirname, '../../.vscodeignore'), 'utf8');
    const rules = ignore.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    expect(rules).toContain('docs/**');
    expect(rules).toContain('!docs/');
    expect(rules).toContain('!docs/format-and-profile-boundaries.md');
    expect(rules).toContain('!docs/assets/');
    expect(rules).toContain('docs/assets/**');
    expect(rules.filter((line) => line.startsWith('!docs/assets/'))).toEqual([
      '!docs/assets/',
      ...NPM_PUBLIC_ASSETS.map((asset: string) => `!${asset}`),
    ]);
  });
});
