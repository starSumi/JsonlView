import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { collectLicenseInventory, renderOutputs } from './check-cargo-notices.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse((await runCargoMetadata()).replace(/^\uFEFF/, ''));
const packages = metadata.packages
  .filter((pkg) => typeof pkg.source === 'string' && pkg.source.startsWith('registry+'))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const inventory = await collectLicenseInventory(packages);
const noticesPath = resolve(root, 'THIRD-PARTY-NOTICES.txt');
const output = renderOutputs(inventory, await readFile(noticesPath, 'utf8'));
const licenseDirectory = resolve(root, 'third_party/licenses');

await mkdir(licenseDirectory, { recursive: true });
for (const entry of await readdir(licenseDirectory, { withFileTypes: true })) {
  if (entry.isFile() && entry.name !== 'README.md' && !output.licenses.has(entry.name)) {
    await rm(resolve(licenseDirectory, entry.name));
  }
}
for (const [name, contents] of output.licenses) {
  await writeFile(resolve(licenseDirectory, name), normalizeText(contents), 'utf8');
}
await writeFile(noticesPath, normalizeText(output.notices), 'utf8');
console.log(JSON.stringify({ ok: true, packages: inventory.length, licenseFiles: output.licenses.size }, null, 2));

async function runCargoMetadata() {
  const result = await execFile('cargo', [
    'metadata', '--manifest-path', resolve(root, 'native/jsonl-core/Cargo.toml'), '--locked', '--format-version', '1',
  ], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

function normalizeText(value) {
  return value.replaceAll('\r\n', '\n').trimEnd() + '\n';
}
