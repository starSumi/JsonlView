import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript release helper has no emitted declaration file.
import { checkPublicSurface, checkReadmeShowcase } from '../../scripts/check-public-surface.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('public surface release guard', () => {
  it('requires the single retained Codex timeline and requested showcase order', () => {
    const readme = [
      '### Diff and prompt detail',
      '![diff](docs/assets/claude-diff.png)',
      '### Agent profile timelines',
      '![timeline](docs/assets/codex-timeline-exec.png)',
      '### Event analysis',
      '![events](docs/assets/rollout-event-insights.png)',
    ].join('\n');
    expect(checkReadmeShowcase(readme)).toMatchObject({ ok: true, retainedTimeline: ['docs/assets/codex-timeline-exec.png'] });
    expect(checkReadmeShowcase(readme.replace('codex-timeline-exec.png', 'pi-timeline.png')).ok).toBe(false);
  });

  it('rejects absolute local paths in release-facing markdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-public-surface-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'README.md'), [
      '### Diff and prompt detail',
      '![diff](docs/assets/claude-diff.png)',
      '### Agent profile timelines',
      '![timeline](docs/assets/codex-timeline-exec.png)',
      '### Event analysis',
      '![events](docs/assets/rollout-event-insights.png)',
    ].join('\n'));
    await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n');
    await writeFile(join(root, 'package.json'), '{}\n');
    await writeFile(join(root, 'docs', 'decision.md'), 'Study root: F:/playground/provider\n');

    const result = await checkPublicSurface(root);
    expect(result.ok).toBe(false);
    expect(result.pathLeaks).toEqual([{ file: 'docs/decision.md', line: 1, detail: 'absolute local path marker' }]);
    expect(result.missingAssets).toEqual(expect.arrayContaining([
      'docs/assets/claude-diff.png',
      'docs/assets/codex-timeline-exec.png',
      'docs/assets/rollout-event-insights.png',
    ]));
  });

  it('rejects UNC paths while allowing stable placeholders and provider homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-public-surface-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'README.md'), [
      '### Diff and prompt detail',
      '![diff](docs/assets/claude-diff.png)',
      '### Agent profile timelines',
      '![timeline](docs/assets/codex-timeline-exec.png)',
      '### Event analysis',
      '![events](docs/assets/rollout-event-insights.png)',
    ].join('\n'));
    await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n');
    await writeFile(join(root, 'package.json'), '{}\n');
    await writeFile(join(root, 'docs', 'decision.md'), 'Study root: \\\\private-share\\notes; use <workspace> and ~/.codex in contracts.\n');

    const result = await checkPublicSurface(root);
    expect(result.ok).toBe(false);
    expect(result.pathLeaks).toEqual([{ file: 'docs/decision.md', line: 1, detail: 'absolute local path marker' }]);
  });
});
