import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

const root = process.cwd();
const sourceRoot = resolve(root, 'src/webview');
const config = JSON.parse(await readFile(resolve(root, 'config/webview-architecture.json'), 'utf8'));
const facadePaths = new Map(config.facades.map(({ path, owner }) => [normalize(resolve(root, path)), owner]));
const privateRoots = config.privateRoots.map(({ path, entry }) => ({
  root: normalize(resolve(root, path)),
  entry: normalize(resolve(root, entry)),
}));
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

function isWithin(candidate, directory) {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith('..') && !path.includes(':') && !path.startsWith('/'));
}

function resolveImport(importer, specifier, sourcePaths) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    ...[...sourceExtensions].map((extension) => base + extension),
    ...[...sourceExtensions].map((extension) => join(base, 'index' + extension)),
  ];
  return candidates.find((candidate) => sourcePaths.has(normalize(candidate)));
}

const failures = [];
const sourceFiles = await collectSources(sourceRoot);
const sourcePaths = new Set(sourceFiles.map((path) => normalize(path)));
for (const importer of sourceFiles) {
  const content = await readFile(importer, 'utf8');
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    const target = resolveImport(importer, specifier, sourcePaths);
    if (!target || normalize(importer) === normalize(target)) continue;
    const normalizedImporter = normalize(importer);
    const normalizedTarget = normalize(target);
    if (facadePaths.has(normalizedTarget)) {
      failures.push({
        kind: 'facade-import',
        importer: relative(root, importer).replaceAll('\\', '/'),
        facade: relative(root, target).replaceAll('\\', '/'),
        owner: facadePaths.get(normalizedTarget),
      });
    }
    for (const privateRoot of privateRoots) {
      if (!isWithin(normalizedTarget, privateRoot.root) || normalizedTarget === privateRoot.entry) continue;
      if (isWithin(normalizedImporter, privateRoot.root) || facadePaths.has(normalizedImporter)) continue;
      failures.push({
        kind: 'private-widget-deep-import',
        importer: relative(root, importer).replaceAll('\\', '/'),
        target: relative(root, target).replaceAll('\\', '/'),
        entry: relative(root, privateRoot.entry).replaceAll('\\', '/'),
      });
    }
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, rule: 'production webview modules must import facade owners directly and widgets through their public entry', failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checked: { sourceRoot: 'src/webview', facades: facadePaths.size, privateRoots: privateRoots.length } }));
}
