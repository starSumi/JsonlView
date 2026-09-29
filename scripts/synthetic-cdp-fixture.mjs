import { lstat, mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOutsideTree } from './path-boundary.mjs';

const FIXTURE_NAME = 'synthetic.jsonl';
const MAX_BYTES = 32 * 1024 * 1024;

function samePath(left, right) {
  return relative(resolve(left), resolve(right)) === ''
    && relative(resolve(right), resolve(left)) === '';
}

async function assertRealOutputBase(outputDirectory) {
  const logicalDirectory = resolve(outputDirectory);
  const [directoryStats, physicalDirectory] = await Promise.all([
    lstat(logicalDirectory), realpath(logicalDirectory),
  ]);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
    || !samePath(logicalDirectory, physicalDirectory)) {
    throw new Error('Synthetic output directory must be a real directory, not a link.');
  }
  return physicalDirectory;
}

export async function createMutableSyntheticFixture(outputDirectory, rows = 4, payloadBytes = 0) {
  if (!Number.isSafeInteger(rows) || rows < 2 || rows > 1_000
    || !Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > 16_384) {
    throw new Error('Synthetic fixture requires 2..1000 rows and 0..16384 payload bytes per row.');
  }
  await assertOutsideTree(resolve(import.meta.dirname, '..'), outputDirectory, 'Synthetic fixture output');
  await mkdir(outputDirectory, { recursive: true });
  await assertOutsideTree(resolve(import.meta.dirname, '..'), outputDirectory, 'Synthetic fixture output');
  const physicalDirectory = await assertRealOutputBase(outputDirectory);
  const fixtureDirectory = await mkdtemp(join(physicalDirectory, 'synthetic-fixture-'));
  const fixture = join(fixtureDirectory, FIXTURE_NAME);
  const handle = await open(fixture, 'wx+');
  try {
    let firstLine;
    for (let ordinal = 0; ordinal < rows; ordinal += 1) {
      const line = `${JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'info',
        message: `Synthetic acceptance event ${ordinal}`,
        payload: 'x'.repeat(payloadBytes),
      })}\n`;
      if (ordinal === 0) firstLine = line;
      await handle.writeFile(line);
    }
    await handle.sync();
    const stats = await handle.stat();
    if (stats.size > MAX_BYTES || stats.nlink !== 1) throw new Error('Synthetic fixture exceeds the size or link limit.');
    return {
      fixture,
      async change(kind) {
        if (!['append', 'truncate', 'rewrite'].includes(kind)) throw new Error('Unsupported synthetic change.');
        const [owned, path] = await Promise.all([handle.stat({ bigint: true }), lstat(fixture, { bigint: true })]);
        if (!path.isFile() || path.isSymbolicLink() || owned.dev === 0n || owned.ino === 0n
          || owned.dev !== path.dev || owned.ino !== path.ino || owned.nlink !== 1n) {
          throw new Error('Synthetic fixture path no longer identifies the owned file.');
        }
        if (kind === 'truncate') {
          await handle.truncate(0);
        } else {
          const contents = kind === 'append'
            ? Buffer.from(`${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', message: 'Synthetic acceptance event appended' })}\n`)
            : Buffer.from('warn');
          const offset = kind === 'append' ? Number(owned.size)
            : firstLine.indexOf('"level":"info"') + '"level":"'.length;
          if (kind === 'append' && owned.size + BigInt(contents.length) > BigInt(MAX_BYTES)) {
            throw new Error('Synthetic append exceeds the fixture byte limit.');
          }
          let written = 0;
          while (written < contents.length) {
            const result = await handle.write(contents, written, contents.length - written, offset + written);
            if (result.bytesWritten === 0) throw new Error('Synthetic change made no progress.');
            written += result.bytesWritten;
          }
        }
        await handle.sync();
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function prepareSyntheticFixture(outputDirectory, rows = 4, payloadBytes = 0) {
  const owned = await createMutableSyntheticFixture(outputDirectory, rows, payloadBytes);
  try {
    return owned.fixture;
  } finally {
    await owned.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputDirectory, rowArgument, payloadArgument] = process.argv.slice(2);
  if (!outputDirectory) throw new Error('Usage: node scripts/synthetic-cdp-fixture.mjs <output-directory> [rows] [payload-bytes]');
  const fixture = await prepareSyntheticFixture(resolve(outputDirectory),
    rowArgument === undefined ? 4 : Number(rowArgument),
    payloadArgument === undefined ? 0 : Number(payloadArgument));
  console.log(JSON.stringify({ fixture }));
}
