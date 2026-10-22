import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

const root = process.cwd();
const sourceRoot = resolve(root, 'src/webview');
const config = JSON.parse(await readFile(resolve(root, 'config/webview-architecture.json'), 'utf8'));
const facadePaths = new Map(config.facades.map(({ path, owner }) => [normalize(resolve(root, path)), owner]));
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gmu;

async function collectSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSources(path));
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    ...[...sourceExtensions].map((extension) => base + extension),
    ...[...sourceExtensions].map((extension) => join(base, 'index' + extension)),
  ];
  return candidates.find((candidate) => facadePaths.has(normalize(candidate)));
}

const failures = [];
for (const importer of await collectSources(sourceRoot)) {
  const content = await readFile(importer, 'utf8');
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    const target = resolveImport(importer, specifier);
    if (!target || normalize(importer) === normalize(target)) continue;
    failures.push({
      importer: relative(root, importer).replaceAll('\\', '/'),
      facade: relative(root, target).replaceAll('\\', '/'),
      owner: facadePaths.get(normalize(target)),
    });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, rule: 'production webview modules must import facade owners directly', failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checked: { sourceRoot: 'src/webview', facades: facadePaths.size } }));
}
