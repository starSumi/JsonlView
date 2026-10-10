import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_ROOT_FILES = ['README.md', 'CHANGELOG.md', 'package.json'];
const PUBLIC_DOC_ROOT = 'docs';
const PATH_MARKER = /(?<![A-Za-z])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/(?:Users|home|private|tmp|mnt|workspace)\/)/i;
const REQUIRED_TIMELINE = 'docs/assets/codex-timeline-exec.png';

if (isMainModule()) {
  const root = parseRoot(process.argv.slice(2));
  const result = await checkPublicSurface(root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

export async function checkPublicSurface(root = DEFAULT_ROOT) {
  const projectRoot = resolve(root);
  const files = await collectPublicTextFiles(projectRoot);
  const pathLeaks = [];
  for (const file of files) {
    const text = await readFile(join(projectRoot, file), 'utf8');
    if (text.includes('\0')) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (PATH_MARKER.test(line)) {
        pathLeaks.push({ file, line: index + 1, detail: 'absolute local path marker' });
      }
    });
  }

  const readme = await readFile(join(projectRoot, 'README.md'), 'utf8');
  const showcase = checkReadmeShowcase(readme);
  const referencedAssets = [...readme.matchAll(/\((docs\/assets\/[^)]+)\)/g)].map((match) => match[1]);
  const missingAssets = [];
  for (const asset of referencedAssets) {
    try {
      await access(join(projectRoot, asset));
    } catch {
      missingAssets.push(asset);
    }
  }
  return {
    schemaVersion: 1,
    ok: pathLeaks.length === 0 && showcase.ok && missingAssets.length === 0,
    filesScanned: files,
    pathLeaks,
    showcase,
    missingAssets,
  };
}

export async function collectPublicTextFiles(root) {
  const files = [];
  for (const file of PUBLIC_ROOT_FILES) {
    files.push(file);
  }
  await collectMarkdownFiles(join(root, PUBLIC_DOC_ROOT), PUBLIC_DOC_ROOT, files);
  return files.sort();
}

async function collectMarkdownFiles(directory, prefix, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`.replaceAll('\\', '/');
    if (entry.isDirectory()) {
      await collectMarkdownFiles(path, relativePath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(relativePath);
    }
  }
}

export function checkReadmeShowcase(readme) {
  const failures = [];
  const headings = [...readme.matchAll(/^### (.+)$/gm)].map((match) => ({
    title: match[1].trim(),
    index: match.index ?? 0,
  }));
  const position = (title) => headings.find((heading) => heading.title === title)?.index ?? -1;
  const diff = position('Diff and prompt detail');
  const timelines = position('Agent profile timelines');
  const events = position('Event analysis');
  if (!(diff >= 0 && timelines > diff && events > timelines)) {
    failures.push('showcase sections must be ordered Diff and prompt detail, Agent profile timelines, Event analysis');
  }
  for (const title of ['Record detail', 'Telemetry schema']) {
    if (position(title) >= 0) failures.push(`showcase section must be omitted: ${title}`);
  }

  const timelineEnd = headings.find((heading) => heading.index > timelines)?.index ?? readme.length;
  const timelineBlock = timelines >= 0 ? readme.slice(timelines, timelineEnd) : '';
  const timelineAssets = [...timelineBlock.matchAll(/\((docs\/assets\/[^)]+\.png)\)/g)].map((match) => match[1]);
  if (timelineAssets.length !== 1 || timelineAssets[0] !== REQUIRED_TIMELINE) {
    failures.push(`Agent profile timelines must contain only ${REQUIRED_TIMELINE}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    retainedTimeline: timelineAssets,
  };
}

function parseRoot(args) {
  const index = args.indexOf('--root');
  return index >= 0 && args[index + 1] ? args[index + 1] : DEFAULT_ROOT;
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename);
}
