import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import tsconfig from '../tsconfig.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const facadePath = resolve(root, 'src/shared/query-dto.ts');
const comparablePath = (path) => {
  const normalized = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

function resolveConfiguredModule(specifier, importerPath) {
  const candidates = [];
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const baseUrl = resolve(root, tsconfig.compilerOptions?.baseUrl ?? '.');

  if (specifier.startsWith('.')) {
    candidates.push(resolve(dirname(importerPath), specifier));
  } else {
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf('*');
      const prefix = star < 0 ? pattern : pattern.slice(0, star);
      const suffix = star < 0 ? '' : pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      const matched = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
      for (const target of targets) {
        const targetStar = target.indexOf('*');
        const mapped = targetStar < 0
          ? target
          : target.slice(0, targetStar) + matched + target.slice(targetStar + 1);
        candidates.push(resolve(baseUrl, mapped));
      }
    }
  }

  for (const candidate of candidates) {
    const extension = extname(candidate);
    const substitutions = extension === '.js' ? ['.ts', '.tsx', '.d.ts']
      : extension === '.mjs' ? ['.mts']
        : extension === '.cjs' ? ['.cts']
          : extension === '' ? ['.ts', '.tsx', '.d.ts'] : [];
    const probes = [candidate, ...substitutions.map((item) => candidate.slice(0, candidate.length - extension.length) + item)];
    if (extension === '') probes.push(resolve(candidate, 'index.ts'), resolve(candidate, 'index.tsx'));
    for (const probe of probes) {
      if (comparablePath(probe) === comparablePath(facadePath)) return facadePath;
    }
  }
  return undefined;
}

function parseSource(sourceText, filePath) {
  return parse(sourceText, {
    sourceType: 'unambiguous',
    sourceFilename: filePath,
    plugins: ['typescript', ...(filePath.endsWith('.tsx') ? ['jsx'] : []), 'importAttributes', 'topLevelAwait'],
  });
}

export function findDeprecatedQueryDtoImports(filePath, sourceText) {
  const absoluteFilePath = resolve(root, filePath);
  if (absoluteFilePath === facadePath) return [];

  const ast = parseSource(sourceText, filePath);
  const references = [];

  function checkModuleSpecifier(node) {
    if (node?.type !== 'StringLiteral') return;
    if (resolveConfiguredModule(node.value, absoluteFilePath) === facadePath) {
      references.push({
        file: relative(root, absoluteFilePath).replaceAll('\\', '/'),
        line: node.loc?.start.line ?? 1,
        specifier: node.value,
      });
    }
  }

  function visit(node) {
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && node.source !== null
    ) {
      checkModuleSpecifier(node.source);
    } else if (node.type === 'TSImportType') {
      checkModuleSpecifier(node.argument);
    } else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
      checkModuleSpecifier(node.moduleReference.expression);
    } else if (node.type === 'CallExpression' && (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require'))) {
      checkModuleSpecifier(node.arguments[0]);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key === 'tokens') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child !== null && typeof child === 'object') visit(child);
        }
      }
      else if (value !== null && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  return references.sort((left, right) => left.line - right.line);
}

async function collectTypeScriptFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectTypeScriptFiles(path, files);
    else if (entry.isFile() && (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx')) files.push(path);
  }
  return files;
}

export async function checkDeprecatedQueryDtoImports(sourceRoot = resolve(root, 'src')) {
  const sourceFiles = await collectTypeScriptFiles(sourceRoot);
  const violations = [];
  for (const file of sourceFiles) {
    const filePath = relative(root, file).replaceAll('\\', '/');
    violations.push(...findDeprecatedQueryDtoImports(filePath, await readFile(file, 'utf8')));
  }
  return { checkedFiles: sourceFiles.length, violations };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await checkDeprecatedQueryDtoImports();
    if (result.violations.length > 0) {
      console.error(JSON.stringify({ ok: false, ...result }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ ok: true, checkedFiles: result.checkedFiles }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  }
}
