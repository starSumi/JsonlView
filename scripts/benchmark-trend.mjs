import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { cpus, release } from 'node:os';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { artifactDirectory } from './artifact-directory.mjs';

const execFile = promisify(execFileCallback);
const TREND_SCHEMA_VERSION = 2;
// Bump when the measured workload or aggregation semantics change. Keeping
// this separate from the report schema invalidates old baselines explicitly.
const BENCHMARK_WORKLOAD_VERSION = 1;
const MAX_HISTORY_SAMPLES = 256;
const options = parseArgs(process.argv.slice(2));
await mkdir(resolve(options.out, '..'), { recursive: true });
await mkdir(resolve(options.history, '..'), { recursive: true });
await mkdir(options.work, { recursive: true });
const fixture = resolve(options.work, `fixture-${Date.now()}.jsonl`);
await run(process.execPath, ['scripts/generate-fixture.mjs', '--output', fixture, '--profile', options.profile, '--records', String(options.records), '--payload-bytes', String(options.payloadBytes)]);
const benchmark = JSON.parse(await run(process.execPath, ['scripts/benchmark-engine.mjs', '--file', fixture, '--scanner', options.scanner, '--no-query'], true));
const fixtureSha256 = await digestFile(fixture);
const lockfileSha256 = await digestFile('pnpm-lock.yaml');
const gitSha = await readGitSha();
const gitState = await readGitState();
const environment = {
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  osRelease: release(),
  cpuModel: cpus()[0]?.model ?? 'unknown',
};
const current = {
  schemaVersion: TREND_SCHEMA_VERSION,
  recordedAt: new Date().toISOString(),
  provenance: {
    workloadVersion: BENCHMARK_WORKLOAD_VERSION,
    gitSha,
    gitState: gitState.state,
    gitStatusSha256: gitState.statusSha256,
    gitDiffSha256: gitState.diffSha256,
    lockfileSha256,
    fixtureSha256,
    environment,
  },
  fixture: { profile: options.profile, records: options.records, payloadBytes: options.payloadBytes, sha256: fixtureSha256 },
  runtime: benchmark.runtime,
  timings: benchmark.timings,
  memory: benchmark.memory,
  result: benchmark.result,
};
const history = await readHistory(options.history);
const comparable = history.items.filter((item) => sameWorkload(item, current));
const baseline = comparable.length ? {
  samples: comparable.length,
  openMs: median(comparable.map((item) => item.timings.openMs)),
  firstPageMs: median(comparable.map((item) => item.timings.firstPageMs)),
  fullIndexMs: median(comparable.map((item) => item.timings.fullIndexMs)),
  reversePageMs: median(comparable.map((item) => item.timings.reversePageMs)),
  peakObservedRssBytes: median(comparable.map((item) => item.memory?.peakObservedRssBytes)),
} : undefined;
const report = {
  schemaVersion: TREND_SCHEMA_VERSION,
  current,
  baseline,
  comparison: baseline ? 'comparable' : 'no-comparable-baseline',
  delta: baseline ? {
    openMs: delta(current.timings.openMs, baseline.openMs),
    firstPageMs: delta(current.timings.firstPageMs, baseline.firstPageMs),
    fullIndexMs: delta(current.timings.fullIndexMs, baseline.fullIndexMs),
    reversePageMs: delta(current.timings.reversePageMs, baseline.reversePageMs),
    peakObservedRssBytes: delta(current.memory?.peakObservedRssBytes, baseline.peakObservedRssBytes, 'bytes'),
  } : undefined,
  history: {
    file: options.history,
    samplesRead: history.items.length,
    invalidLines: history.invalidLines,
    capped: history.capped,
  },
  historyFile: options.history,
};
await appendFile(options.history, `${JSON.stringify(current)}\n`, 'utf8');
await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));

function parseArgs(args) {
  args = stripLeadingScriptSeparator(args);
  const parsed = {
    out: resolve(artifactDirectory('benchmarks', 'trend.json')),
    history: resolve(artifactDirectory('benchmarks', 'trend.jsonl')),
    work: resolve(artifactDirectory('benchmarks', 'fixtures')),
    profile: 'mixed', records: 5000, payloadBytes: 128, scanner: 'off',
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (key === '--out') parsed.out = resolve(value);
    else if (key === '--history') parsed.history = resolve(value);
    else if (key === '--work') parsed.work = resolve(value);
    else if (key === '--profile' && ['generic', 'codex', 'claude', 'mixed'].includes(value)) parsed.profile = value;
    else if (key === '--scanner' && ['off', 'auto', 'on'].includes(value)) parsed.scanner = value;
    else if (key === '--records') parsed.records = positiveInteger(value, key);
    else if (key === '--payload-bytes') parsed.payloadBytes = nonNegativeInteger(value, key);
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  return parsed;
}

/**
 * pnpm may forward the conventional script separator as argv[0]. Consume one
 * transport marker; a second marker remains visible and is rejected as an
 * unknown argument instead of being silently swallowed.
 */
export function stripLeadingScriptSeparator(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

function run(command, args, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let stdout = '';
    if (capture) child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function readHistory(path) {
  try {
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
    const capped = lines.length > MAX_HISTORY_SAMPLES;
    const items = [];
    let invalidLines = 0;
    for (const line of (capped ? lines.slice(-MAX_HISTORY_SAMPLES) : lines)) {
      try {
        const item = JSON.parse(line);
        if (item && typeof item === 'object') items.push(item);
        else invalidLines += 1;
      } catch {
        invalidLines += 1;
      }
    }
    return { items, invalidLines, capped };
  } catch (error) {
    if (error?.code === 'ENOENT') return { items: [], invalidLines: 0, capped: false };
    throw error;
  }
}

function sameWorkload(left, right) {
  const leftProvenance = left?.provenance;
  const rightProvenance = right?.provenance;
  const leftEnvironment = leftProvenance?.environment;
  const rightEnvironment = rightProvenance?.environment;
  return left?.schemaVersion === right?.schemaVersion
    && leftProvenance?.workloadVersion === rightProvenance?.workloadVersion
    && left?.fixture?.sha256 === right?.fixture?.sha256
    && left?.fixture?.profile === right?.fixture?.profile
    && left?.fixture?.records === right?.fixture?.records
    && left?.fixture?.payloadBytes === right?.fixture?.payloadBytes
    && left?.runtime?.scanner === right?.runtime?.scanner
    && left?.runtime?.platform === right?.runtime?.platform
    && left?.runtime?.architecture === right?.runtime?.architecture
    // A dirty checkout is useful for a local sample but is not a trustworthy
    // baseline. Compare only clean source trees with the same dependency and
    // runtime environment; gitSha itself may differ because trends measure
    // changes across clean revisions.
    && leftProvenance?.gitState === 'clean'
    && rightProvenance?.gitState === 'clean'
    && isKnownDigest(leftProvenance?.lockfileSha256)
    && isKnownDigest(rightProvenance?.lockfileSha256)
    && leftProvenance?.lockfileSha256 === rightProvenance?.lockfileSha256
    && isKnownDigest(leftProvenance?.fixtureSha256)
    && isKnownDigest(rightProvenance?.fixtureSha256)
    && leftEnvironment?.node === rightEnvironment?.node
    && leftEnvironment?.platform === rightEnvironment?.platform
    && leftEnvironment?.architecture === rightEnvironment?.architecture
    && leftEnvironment?.osRelease === rightEnvironment?.osRelease
    && leftEnvironment?.cpuModel === rightEnvironment?.cpuModel;
}

function isKnownDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return undefined;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : Math.round(((ordered[middle - 1] + ordered[middle]) / 2) * 1000) / 1000;
}

function delta(current, baseline, unit = 'milliseconds') {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return undefined;
  return { [unit]: Math.round((current - baseline) * 1000) / 1000, percent: baseline === 0 ? undefined : Math.round(((current - baseline) / baseline) * 10000) / 100 };
}

async function digestFile(path) {
  try {
    const contents = await readFile(resolve(path));
    return createHash('sha256').update(contents).digest('hex');
  } catch {
    return 'unavailable';
  }
}

async function readGitSha() {
  try {
    const result = await execFile('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), windowsHide: true });
    const sha = result.stdout.trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function readGitState() {
  try {
    const [status, unstaged, staged] = await Promise.all([
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: process.cwd(), windowsHide: true }),
      execFile('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], { cwd: process.cwd(), windowsHide: true }),
      execFile('git', ['diff', '--cached', '--no-ext-diff', '--binary', 'HEAD'], { cwd: process.cwd(), windowsHide: true }),
    ]);
    const statusText = status.stdout;
    return {
      state: statusText.trim().length === 0 ? 'clean' : 'dirty',
      statusSha256: digestText(statusText),
      diffSha256: digestText(`${unstaged.stdout}\n${staged.stdout}`),
    };
  } catch {
    return { state: 'unknown', statusSha256: 'unavailable', diffSha256: 'unavailable' };
  }
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return parsed;
}
