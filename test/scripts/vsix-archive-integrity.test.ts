import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { inspectVsixArchive, VSIX_CONTENT_TYPES_ENTRY, VSIX_MANIFEST_ENTRY } from '../../scripts/vsix-archive-integrity.mjs';
// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { VSIX_REQUIRED_FILES } from '../../scripts/vsix-package-policy.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('VSIX archive integrity', () => {
  it('accepts a complete archive that follows the explicit package policy', async () => {
    const archive = await writeArchive('valid', completeEntries());

    await expect(inspectVsixArchive(archive)).resolves.toMatchObject({
      identity: {
        package: { name: 'jsonl-view', displayName: 'JsonlView', publisher: 'Sumi-Sophia', version: '0.2.11' },
        vsixManifest: { name: 'jsonl-view', displayName: 'JsonlView', publisher: 'Sumi-Sophia', version: '0.2.11' },
      },
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'extension/package.nls.json' }),
        expect.objectContaining({ path: 'extension/docs/format-and-profile-boundaries.md' }),
      ]),
    });
  });

  it('rejects an archive missing package.nls or required legal payload', async () => {
    const missingPackageNls = await writeArchive('missing-package-nls', completeEntries()
      .filter((entry) => entry.name !== 'extension/package.nls.json'));
    await expect(inspectVsixArchive(missingPackageNls)).rejects.toThrow(/package\.nls\.json/i);

    const missingLicense = await writeArchive('missing-license', completeEntries()
      .filter((entry) => entry.name !== 'extension/LICENSE.txt'));
    await expect(inspectVsixArchive(missingLicense)).rejects.toThrow(/LICENSE\.txt/i);

    const missingThirdParty = await writeArchive('missing-third-party', completeEntries()
      .filter((entry) => entry.name !== 'extension/third_party/licenses/vendor.txt'));
    await expect(inspectVsixArchive(missingThirdParty)).rejects.toThrow(/third-party license|third_party/i);
  });

  it('rejects internal decision records outside the VSIX public surface', async () => {
    const archive = await writeArchive('internal-docs', [
      ...completeEntries(),
      { name: 'extension/docs/decisions/001-internal.md', contents: Buffer.from('internal', 'utf8') },
    ]);

    await expect(inspectVsixArchive(archive)).rejects.toThrow(/outside the explicit package policy|docs\/decisions/i);
  });
});

async function writeArchive(label: string, entries: Array<{ name: string; contents: Buffer }>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `jsonl-view-vsix-integrity-${label}-`));
  temporaryDirectories.push(directory);
  const path = join(directory, `${label}.vsix`);
  await writeFile(path, createStoredZip(entries));
  return path;
}

function completeEntries(): Array<{ name: string; contents: Buffer }> {
  const entries = new Map<string, Buffer>();
  entries.set(VSIX_CONTENT_TYPES_ENTRY, Buffer.from('<Types />', 'utf8'));
  entries.set(VSIX_MANIFEST_ENTRY, Buffer.from(
    '<PackageManifest><Metadata><Identity Id="jsonl-view" Version="0.2.11" Publisher="Sumi-Sophia" />'
      + '<DisplayName>JsonlView</DisplayName></Metadata></PackageManifest>',
    'utf8',
  ));

  for (const path of VSIX_REQUIRED_FILES) {
    entries.set(`extension/${path}`, Buffer.from(`fixture:${path}`, 'utf8'));
  }
  entries.set('extension/package.json', Buffer.from(JSON.stringify({
    name: 'jsonl-view',
    displayName: 'JsonlView',
    publisher: 'Sumi-Sophia',
    version: '0.2.11',
  }), 'utf8'));
  entries.set('extension/third_party/licenses/vendor.txt', Buffer.from('vendor license', 'utf8'));

  return [...entries].map(([name, contents]) => ({ name, contents }));
}

function createStoredZip(entries: Array<{ name: string; contents: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.contents.length, 18);
    local.writeUInt32LE(entry.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.contents.length, 20);
    central.writeUInt32LE(entry.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.contents.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
