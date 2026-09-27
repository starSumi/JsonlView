import { execFileSync } from 'node:child_process';

const implementationRoots = ['src/', 'native/jsonl-core/src/'];

export function parseArgs(args) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  let base;
  let head = 'HEAD';

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const argument = normalizedArgs[index];
    if (argument === '--base' && normalizedArgs[index + 1]) {
      base = normalizedArgs[++index];
      continue;
    }
    if (argument === '--head' && normalizedArgs[index + 1]) {
      head = normalizedArgs[++index];
      continue;
    }
    if (argument === '--help') return { help: true };
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }

  if (!base) throw new Error('Missing required --base <commit> argument.');
  return { base, head };
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    if (allowFailure) return undefined;
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function readCommitFile(cwd, revision, file) {
  return git(cwd, ['show', `${revision}:${file}`], { allowFailure: true });
}

function implementationFile(file) {
  return implementationRoots.some((root) => file.startsWith(root));
}

function unreleasedSection(content) {
  if (!content) return undefined;
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+\[?Unreleased\]?(?:\s|$)/i.test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function bulletCounts(lines) {
  const counts = new Map();
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+(\S.*)$/);
    if (!match) continue;
    const bullet = match[1].trim().replace(/\s+/g, ' ');
    counts.set(bullet, (counts.get(bullet) ?? 0) + 1);
  }
  return counts;
}

function hasAddedUnreleasedBullet(previous, current) {
  const previousCounts = bulletCounts(unreleasedSection(previous) ?? []);
  const currentCounts = bulletCounts(unreleasedSection(current) ?? []);
  for (const [bullet, count] of currentCounts) {
    if (count > (previousCounts.get(bullet) ?? 0)) return true;
  }
  return false;
}

export function checkChangelog({ cwd = process.cwd(), base, head = 'HEAD' }) {
  if (/^0+$/.test(base)) {
    return { status: 'skipped', reason: 'The push has no parent revision.' };
  }

  const mergeBase = git(cwd, ['merge-base', base, head]).trim();
  const changedFiles = git(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head])
    .split('\0')
    .filter(Boolean);
  const implementationChanges = changedFiles.filter(implementationFile);

  if (implementationChanges.length === 0) {
    return { status: 'passed', reason: 'No implementation-source changes.' };
  }

  if (!changedFiles.includes('CHANGELOG.md')) {
    throw new Error('Implementation-source changes require a new bullet under ## Unreleased in CHANGELOG.md.');
  }

  const previousChangelog = readCommitFile(cwd, mergeBase, 'CHANGELOG.md') ?? '';
  const currentChangelog = readCommitFile(cwd, head, 'CHANGELOG.md');
  if (!unreleasedSection(currentChangelog)) {
    throw new Error('CHANGELOG.md must contain a ## Unreleased section.');
  }
  if (!hasAddedUnreleasedBullet(previousChangelog, currentChangelog)) {
    throw new Error('CHANGELOG.md changed, but adds no new bullet under ## Unreleased.');
  }

  return { status: 'passed', implementationChanges };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/check-changelog.mjs --base <commit> [--head <commit>]\n');
    return;
  }

  const result = checkChangelog(options);
  process.stdout.write(`Changelog guard ${result.status}: ${result.reason ?? result.implementationChanges.join(', ')}\n`);
}

if (process.argv[1]?.endsWith('check-changelog.mjs')) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Changelog guard failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
