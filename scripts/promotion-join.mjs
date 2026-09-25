import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactDirectory } from './artifact-directory.mjs';
import { buildPromotionJoin } from './promotion-plan.mjs';

const root = resolve(import.meta.dirname, '..');

if (isMainModule()) await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [openVsx, marketplace] = await Promise.all([
    readJson(options.openVsx, 'Open VSX promotion plan'),
    readJson(options.marketplace, 'Marketplace promotion plan'),
  ]);
  const joined = buildPromotionJoin({ openVsx, marketplace });
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const output = resolve(options.out ?? artifactDirectory('promotion', `promotion-join-${stamp}.json`));
  await assertOutsideCheckout(output);
  await assertOutputReady(output, options.replace);
  await mkdir(dirname(output), { recursive: true });
  await writeAtomic(output, joined);
  console.log(JSON.stringify({ ok: joined.readyForPromotion, output, pairSha256: joined.pairSha256, blockers: joined.blockers }, null, 2));
  if (!joined.readyForPromotion) process.exitCode = 1;
}

export function parseArgs(args) {
  const input = args[0] === '--' ? args.slice(1) : [...args];
  const parsed = { openVsx: undefined, marketplace: undefined, out: undefined, replace: false };
  for (let index = 0; index < input.length; index += 1) {
    const key = input[index];
    if (key === '--replace') {
      parsed.replace = true;
      continue;
    }
    const value = input[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--open-vsx') parsed.openVsx = value;
    else if (key === '--marketplace') parsed.marketplace = value;
    else if (key === '--out') parsed.out = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  if (parsed.openVsx === undefined || parsed.marketplace === undefined) {
    throw new Error('--open-vsx and --marketplace are required');
  }
  return parsed;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${String(path)}`, { cause: error });
  }
}

async function assertOutsideCheckout(path) {
  const relativePath = relative(root, resolve(path));
  if (relativePath === '' || (!isAbsolute(relativePath) && !relativePath.startsWith('..'))) {
    throw new Error(`promotion join output must be outside the product checkout: ${path}`);
  }
}

async function assertOutputReady(path, replace) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`promotion join output must be a regular file: ${path}`);
    if (!replace) throw new Error(`promotion join output already exists; pass --replace for an intentional overwrite: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}
