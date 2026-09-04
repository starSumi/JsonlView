import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'npm-package');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
run('pnpm', ['build']);
run('pnpm', ['native:build']);

const sourcePackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const packageJson = {
  name: '@sumi-labs/jsonl-view',
  version: sourcePackage.version,
  description: sourcePackage.description,
  license: sourcePackage.license,
  repository: sourcePackage.repository,
  type: sourcePackage.type,
  main: './dist/extension.cjs',
  files: ['dist', 'native/jsonl-core', 'docs', 'README.md', 'CHANGELOG.md', 'LICENSE.txt'],
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
};
await writeFile(resolve(output, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
await cp(resolve(root, 'dist'), resolve(output, 'dist'), { recursive: true });
await mkdir(resolve(output, 'native/jsonl-core'), { recursive: true });
for (const path of [
  'native/jsonl-core/Cargo.lock',
  'native/jsonl-core/Cargo.toml',
  'native/jsonl-core/index.d.ts',
  'native/jsonl-core/jsonl_core.win32-x64-msvc.node',
  'native/jsonl-core/package.json',
]) {
  await cp(resolve(root, path), resolve(output, path));
}
await cp(resolve(root, 'docs'), resolve(output, 'docs'), { recursive: true });
for (const path of ['README.md', 'CHANGELOG.md', 'LICENSE.txt']) {
  await cp(resolve(root, path), resolve(output, path));
}
console.log(`Prepared npm package at ${output}`);
