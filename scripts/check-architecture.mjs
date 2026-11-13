import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

const root = process.cwd();
const sourceRoot = resolve(root, 'src');
const config = JSON.parse(await readFile(resolve(root, 'config/webview-architecture.json'), 'utf8'));
const tsconfig = JSON.parse(await readFile(resolve(root, 'tsconfig.json'), 'utf8'));
const pathAliases = Object.entries(tsconfig.compilerOptions?.paths ?? {}).flatMap(([pattern, targets]) => {
  const target = targets[0];
  if (typeof target !== 'string') return [];
  return [{
    prefix: pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern,
    pattern,
    target,
  }];
});
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
  let base;
  if (specifier.startsWith('.')) {
    base = resolve(dirname(importer), specifier);
  } else {
    const alias = pathAliases.find(({ pattern, prefix }) => pattern.endsWith('/*') ? specifier.startsWith(prefix) : specifier === pattern);
    if (!alias) return undefined;
    const suffix = alias.pattern.endsWith('/*') ? specifier.slice(alias.prefix.length) : '';
    base = resolve(root, alias.target.replaceAll('*', () => suffix));
  }
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

function normalizedRelative(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function matchesBoundaryPath(candidate, configured) {
  const relativePath = normalizedRelative(candidate);
  const normalizedConfigured = configured.replaceAll('\\', '/').replace(/\/$/u, '');
  return relativePath === normalizedConfigured || relativePath.startsWith(`${normalizedConfigured}/`);
}

for (const rule of config.boundaryRules ?? []) {
  const importers = sourceFiles.filter((path) => matchesBoundaryPath(path, rule.from));
  for (const importer of importers) {
    const content = await readFile(importer, 'utf8');
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const target = resolveImport(importer, specifier, sourcePaths);
      if (!target) continue;
      const forbiddenTarget = rule.forbiddenTargets.find((configured) => matchesBoundaryPath(target, configured));
      if (!forbiddenTarget) continue;
      failures.push({
        kind: 'boundary-import',
        rule: rule.name,
        importer: normalizedRelative(importer),
        target: normalizedRelative(target),
        forbiddenTarget,
      });
    }
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, rule: 'architecture-boundaries', failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checked: { sourceRoot: 'src', facades: facadePaths.size, privateRoots: privateRoots.length, boundaryRules: config.boundaryRules?.length ?? 0 } }));
}
