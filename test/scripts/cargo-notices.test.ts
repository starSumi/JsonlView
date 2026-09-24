import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error check-cargo-notices.mjs has no emitted declaration file.
import { collectLicenseInventory, renderOutputs } from '../../scripts/check-cargo-notices.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Cargo license notice inventory', () => {
  it('preserves exact package copyright text and names it by crate version', async () => {
    const packageRoot = await createPackage('sample-crate', '1.2.3');
    const license = 'Copyright (c) Example Owner\n\nPermission granted.\n';
    await writeFile(join(packageRoot, 'LICENSE-MIT'), license, 'utf8');

    const inventory = await collectLicenseInventory([metadata(packageRoot, 'sample-crate', '1.2.3', 'MIT')]);
    const rendered = renderOutputs(inventory);

    expect(rendered.licenses.get('sample-crate-1.2.3-LICENSE-MIT.txt')).toBe(license);
    expect(rendered.notices).toContain('`sample-crate@1.2.3` — License: MIT');
    expect(rendered.notices).toContain('`sample-crate-1.2.3-LICENSE-MIT.txt`');
  });

  it('replaces the generated inventory after a Windows CRLF checkout', async () => {
    const packageRoot = await createPackage('sample-crate', '1.2.3');
    await writeFile(join(packageRoot, 'LICENSE-MIT'), 'Copyright (c) Example Owner\n', 'utf8');
    const inventory = await collectLicenseInventory([metadata(packageRoot, 'sample-crate', '1.2.3', 'MIT')]);
    const initial = renderOutputs(inventory).notices;

    const rendered = renderOutputs(inventory, initial.replaceAll('\n', '\r\n'));

    expect(rendered.notices).toBe(initial);
    expect(rendered.notices.match(/Rust native dependency inventory/g)).toHaveLength(1);
  });

  it('fails closed when a package has no license file or reviewed override', async () => {
    const packageRoot = await createPackage('unknown-crate', '9.9.9');

    await expect(collectLicenseInventory([
      metadata(packageRoot, 'unknown-crate', '9.9.9', 'MIT'),
    ])).rejects.toThrow(/no packaged license\/notice file and no reviewed override/);
  });

  it('binds a napi-rs override to the crate VCS revision', async () => {
    const packageRoot = await createPackage('napi', '3.12.4');
    const overrideRoot = await createTemporaryDirectory('jsonl-view-license-override-');
    await writeFile(join(overrideRoot, 'napi-rs-LICENSE.txt'), 'Copyright (c) upstream\n', 'utf8');
    await writeFile(join(packageRoot, '.cargo_vcs_info.json'), JSON.stringify({
      git: { sha1: '0'.repeat(40) },
    }), 'utf8');

    await expect(collectLicenseInventory([
      metadata(packageRoot, 'napi', '3.12.4', 'MIT'),
    ], { overrideDirectory: overrideRoot })).rejects.toThrow(/override revision does not match/);

    await writeFile(join(packageRoot, '.cargo_vcs_info.json'), JSON.stringify({
      git: { sha1: '1492b220d5ad01807b2dcbd250e8383f9d738311' },
    }), 'utf8');
    await expect(collectLicenseInventory([
      metadata(packageRoot, 'napi', '3.12.4', 'MIT'),
    ], { overrideDirectory: overrideRoot })).rejects.toThrow(/override digest does not match/);
  });
});

async function createPackage(name: string, version: string): Promise<string> {
  const directory = await createTemporaryDirectory('jsonl-view-cargo-package-');
  await writeFile(join(directory, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "${version}"\n`, 'utf8');
  return directory;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function metadata(packageRoot: string, name: string, version: string, license: string): {
  name: string;
  version: string;
  license: string;
  manifest_path: string;
} {
  return { name, version, license, manifest_path: join(packageRoot, 'Cargo.toml') };
}
