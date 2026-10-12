import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(await readFile(join(root, 'config', 'docs-index.json'), 'utf8'));
const indexPath = join(root, config.index);
const indexText = await readFile(indexPath, 'utf8');
const directoryPath = join(root, config.directory);
const files = (await readdir(directoryPath, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
  .map((entry) => entry.name)
  .sort();
const failures = [];

const links = [...indexText.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]);
for (const file of files) {
  const count = links.filter((link) => link === file).length;
  if (count !== 1) failures.push('decision index must link ' + file + ' exactly once (found ' + count + ')');
}
for (const link of links) {
  if (!files.includes(link)) failures.push('decision index has missing or non-decision link: ' + link);
}

const ids = new Map();
for (const file of files) {
  const text = await readFile(join(directoryPath, file), 'utf8');
  const firstHeading = text.match(/^#\s+(.+)$/m)?.[1] || '';
  const standard = firstHeading.match(/^ADR-(\d{3}):\s+/i);
  const legacy = firstHeading.match(/^(\d{3}):\s+/);
  const id = standard?.[1] || legacy?.[1] || config.legacyHeaders?.[file];
  if (!id) {
    failures.push(file + ' must begin with a standard # ADR-NNN: heading or an explicit legacy map');
    continue;
  }
  if (legacy && !config.legacyHeaders?.[file]) failures.push(file + ' uses a legacy heading without a legacy map');
  const entries = ids.get(id) || [];
  entries.push(file);
  ids.set(id, entries);
}
for (const [id, entries] of ids) {
  const allowed = config.allowedDuplicateIds?.[id] || [];
  if (entries.length > 1 && (entries.length !== allowed.length || entries.some((file) => !allowed.includes(file)))) {
    failures.push('ADR-' + id + ' has an unregistered duplicate: ' + entries.join(', '));
  }
}

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const headIndex = args.indexOf('--head');
const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
const head = headIndex >= 0 ? args[headIndex + 1] || 'HEAD' : 'HEAD';
if (base && config.requireStandardHeaderForChanged) {
  const diff = spawnSync('git', ['diff', '--name-only', base + '..' + head, '--', config.directory], {
    cwd: root,
    encoding: 'utf8',
  });
  if (diff.status !== 0) failures.push('Git diff failed while checking changed decision headers');
  for (const relative of (diff.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const file = relative.replaceAll('\\', '/').split('/').pop();
    if (!file || file === 'README.md') continue;
    const text = await readFile(join(directoryPath, file), 'utf8');
    if (!/^#\s+ADR-\d{3}:\s+/m.test(text)) {
      failures.push(file + ' changed in this revision but lacks a standard # ADR-NNN: heading');
    }
  }
}

const result = { ok: failures.length === 0, files: files.length, links: links.length, failures };
const metadata = spawnSync(process.execPath, [join(root, 'scripts', 'check-doc-metadata.mjs')], { cwd: root, encoding: 'utf8' });
if (metadata.status !== 0) failures.push('documentation metadata validation failed: ' + ((metadata.stdout || metadata.stderr || '').trim() || `exit ${metadata.status}`));
result.metadata = metadata.stdout ? JSON.parse(metadata.stdout) : { ok: false };
result.ok = failures.length === 0;
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
