import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const manifest = resolve(root, 'native/jsonl-core/Cargo.toml');
const noticesPath = resolve(root, 'THIRD-PARTY-NOTICES.txt');
const licenseDirectory = resolve(root, 'third_party/licenses');
const overrideDirectory = resolve(root, 'third_party/license-overrides');
const licenseFilePattern = /^(?:LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT)(?:[._-].*)?$/i;
const expectedNoticeHeading = 'Rust native dependency inventory\n--------------------------------';

if (isMainModule()) await main();

async function main() {
  const metadata = JSON.parse((await runCargoMetadata()).replace(/^\uFEFF/, ''));
  const packages = metadata.packages
    .filter((pkg) => typeof pkg.source === 'string' && pkg.source.startsWith('registry+'))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const inventory = await collectLicenseInventory(packages);
  const observedNotices = await readFile(noticesPath, 'utf8');
  const expected = renderOutputs(inventory, observedNotices);
  const observedLicenses = await readDirectory(licenseDirectory);
  const mismatches = [];

  if (normalizeText(observedNotices) !== normalizeText(expected.notices)) {
    mismatches.push('THIRD-PARTY-NOTICES.txt Rust inventory differs from the locked Cargo graph');
  }
  for (const [name, contents] of expected.licenses) {
    const observed = observedLicenses.get(name);
    if (observed === undefined) mismatches.push(`missing third_party/licenses/${name}`);
    else if (normalizeText(observed) !== normalizeText(contents)) mismatches.push(`third_party/licenses/${name} differs from its locked source artifact`);
  }
  for (const name of observedLicenses.keys()) {
    if (name !== 'README.md' && !expected.licenses.has(name)) mismatches.push(`unexpected third_party/licenses/${name}`);
  }

  const result = {
    ok: mismatches.length === 0,
    packageCount: inventory.length,
    licenseFileCount: expected.licenses.size,
    packages: inventory.map(({ name, version, license, noticeFiles }) => ({ name, version, license, noticeFiles: noticeFiles.map((file) => file.outputName) })),
    mismatches,
    notices: toReportPath(noticesPath),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

export async function collectLicenseInventory(packageMetadata, options = {}) {
  const overridesRoot = resolve(options.overrideDirectory ?? overrideDirectory);
  const output = [];
  for (const pkg of packageMetadata) {
    const packageRoot = dirname(pkg.manifest_path);
    const entries = (await readdir(packageRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && licenseFilePattern.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    let source = 'crate';
    let sourceRevision;
    let files = entries.map((entry) => ({ sourcePath: resolve(packageRoot, entry.name), sourceName: entry.name }));
    if (files.length === 0) {
      const override = licenseOverride(pkg);
      if (override === undefined) throw new Error(`${pkg.name}@${pkg.version} has no packaged license/notice file and no reviewed override`);
      const vcs = await readVcsInfo(packageRoot);
      if (vcs?.git?.sha1 !== override.revision) {
        throw new Error(`${pkg.name}@${pkg.version} override revision does not match .cargo_vcs_info.json`);
      }
      source = 'reviewed-override';
      sourceRevision = override.revision;
      files = [{ sourcePath: resolve(overridesRoot, override.file), sourceName: override.file, expectedSha256: override.sha256 }];
    }
    const noticeFiles = [];
    for (const file of files) {
      const contents = await readRegularFile(file.sourcePath);
      if (file.expectedSha256 !== undefined && sha256(normalizeText(contents)) !== file.expectedSha256) {
        throw new Error(`${pkg.name}@${pkg.version} reviewed override digest does not match the pinned upstream text`);
      }
      noticeFiles.push({
        sourceName: file.sourceName,
        outputName: outputName(pkg, file.sourceName),
        contents,
        sha256: sha256(contents),
      });
    }
    output.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? 'UNKNOWN',
      source,
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      noticeFiles,
    });
  }
  return output;
}

export function renderOutputs(inventory, currentNotices = '') {
  const licenses = new Map();
  const noticeLines = inventory.map((pkg) => {
    for (const file of pkg.noticeFiles) licenses.set(file.outputName, file.contents);
    const files = pkg.noticeFiles.map((file) => `\`${file.outputName}\``).join(', ');
    const provenance = pkg.source === 'reviewed-override' ? `; reviewed upstream ${pkg.sourceRevision}` : '';
    return `- \`${pkg.name}@${pkg.version}\` — License: ${pkg.license} — Files: ${files}${provenance}`;
  });
  return { notices: replaceRustSection(currentNotices, noticeLines), licenses };
}

function replaceRustSection(current, noticeLines) {
  const prefix = current.includes(expectedNoticeHeading)
    ? current.slice(0, current.indexOf(expectedNoticeHeading)).trimEnd()
    : current.trimEnd();
  const section = [
    expectedNoticeHeading,
    'The native scanner is built from the exact registry packages resolved by',
    '`native/jsonl-core/Cargo.lock`. Each entry records its Cargo SPDX expression',
    'and the exact upstream license/notice files shipped with the extension.',
    'Files labeled `reviewed upstream` are pinned overrides only for crates whose',
    'published package omitted a license file; the checker binds the override to',
    'the crate\'s `.cargo_vcs_info.json` revision.',
    '',
    ...noticeLines,
    '',
    'The inventory and files are generated from the locked Cargo metadata by',
    '`node scripts/generate-cargo-notices.mjs`; `pnpm check:cargo-notices`',
    'recomputes them and fails on any drift.',
    '',
  ].join('\n');
  return prefix.length === 0 ? section : `${prefix}\n\n${section}`;
}

function licenseOverride(pkg) {
  if (!['napi', 'napi-build', 'napi-derive', 'napi-derive-backend', 'napi-sys'].includes(pkg.name)) return undefined;
  const revision = ['napi', 'napi-derive'].includes(pkg.name)
    ? '1492b220d5ad01807b2dcbd250e8383f9d738311'
    : '31c27a1676a7c4b317f4e144e0a9cb94e8354143';
  return {
    file: 'napi-rs-LICENSE.txt',
    revision,
    sha256: '3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215',
  };
}

function outputName(pkg, sourceName) {
  const normalized = sourceName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.txt$/i, '');
  return `${pkg.name}-${pkg.version}-${normalized}.txt`;
}

async function readVcsInfo(packageRoot) {
  try { return JSON.parse(await readFile(resolve(packageRoot, '.cargo_vcs_info.json'), 'utf8')); } catch { return undefined; }
}

async function readRegularFile(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`license source is not a regular file: ${basename(path)}`);
  return readFile(path, 'utf8');
}

async function readDirectory(directory) {
  const output = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    output.set(entry.name, await readFile(resolve(directory, entry.name), 'utf8'));
  }
  return output;
}

async function runCargoMetadata() {
  const result = await execFile('cargo', [
    'metadata', '--manifest-path', manifest, '--locked', '--format-version', '1',
  ], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  return value.replaceAll('\r\n', '\n').trimEnd() + '\n';
}

function toReportPath(path) {
  return `<workspace>/${relative(root, path).replaceAll(sep, '/')}`;
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}
