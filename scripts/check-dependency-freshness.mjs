import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { artifactDirectory } from './artifact-directory.mjs';

const REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 4;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 4_000;

if (isMainModule()) await main();

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  const checkedAt = new Date().toISOString();
  const packages = await mapWithConcurrency(Object.entries(dependencies), 4, async ([name, requested]) => {
    const entry = { name, requested, checkedAt };
    try {
      const latest = await fetchLatestVersion(name, options);
      entry.latest = latest;
      const comparison = compareVersions(requested, latest);
      entry.status = comparison === 'equal'
        ? 'current'
        : comparison === 'older'
          ? 'outdated'
          : comparison === 'newer'
            ? 'ahead'
            : 'non-semver';
      if (entry.status === 'outdated') entry.distance = versionDistance(requested, latest);
    } catch (error) {
      entry.status = 'error';
      entry.error = error instanceof Error ? error.message : String(error);
    }
    return entry;
  });
  const failures = packages.filter((item) => item.status === 'error').length;

  const report = {
    schemaVersion: 2,
    checkedAt,
    packageManager: manifest.packageManager ?? 'unknown',
    registry: REGISTRY,
    scope: 'direct-manifest-dependencies',
    requestPolicy: {
      attempts: options.attempts,
      timeoutMs: options.timeoutMs,
      concurrency: 4,
      retryableStatuses: [408, 425, 429, 500, 502, 503, 504],
    },
    status: failures > 0 ? 'degraded' : 'ok',
    summary: {
      total: packages.length,
      current: packages.filter((item) => item.status === 'current').length,
      outdated: packages.filter((item) => item.status === 'outdated').length,
      ahead: packages.filter((item) => item.status === 'ahead').length,
      nonSemver: packages.filter((item) => item.status === 'non-semver').length,
      errors: failures,
    },
    packages,
  };
  await mkdir(resolve(options.out, '..'), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (failures > 0) process.exitCode = 1;
  return report;
}

/** Fetch only the small latest-version document, with bounded retries. */
export async function fetchLatestVersion(name, options = {}) {
  const timeoutMs = boundedOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS, 'timeoutMs');
  const attempts = boundedOption(options.attempts ?? DEFAULT_ATTEMPTS, 1, MAX_ATTEMPTS, 'attempts');
  const url = `${REGISTRY}/${encodeURIComponent(name)}/latest`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryableFailure = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`registry returned HTTP ${response.status}`);
          if (!isRetryableStatus(response.status) || attempt === attempts) throw error;
          retryableFailure = true;
          lastError = error;
        } else {
          const metadata = await response.json();
          const latest = typeof metadata?.version === 'string' ? metadata.version : undefined;
          if (!latest) throw new Error('registry response has no latest version');
          return latest;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error instanceof Error && error.name === 'AbortError'
        ? new Error(`registry request timed out after ${timeoutMs} ms`)
        : error;
      // HTTP errors outside the explicit retry set are configuration or
      // identity failures. Preserve the first response and stop immediately.
      if (attempt === attempts || (!retryableFailure && isNonRetryableHttpError(error))) break;
    }
    await delay(backoffMs(attempt));
  }
  throw lastError ?? new Error('registry request failed');
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}

export function parseArgs(args) {
  const parsed = {
    out: resolve(artifactDirectory('maintenance', 'dependency-freshness.json')),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    attempts: DEFAULT_ATTEMPTS,
  };
  if (args[0] === '--') args = args.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('Usage: node scripts/check-dependency-freshness.mjs [--out <path>] [--timeout-ms <ms>] [--attempts <n>]');
    if (key === '--out') parsed.out = resolve(value);
    else if (key === '--timeout-ms') parsed.timeoutMs = boundedOption(value, 1_000, MAX_TIMEOUT_MS, 'timeout-ms');
    else if (key === '--attempts') parsed.attempts = boundedOption(value, 1, MAX_ATTEMPTS, 'attempts');
    else throw new Error('Usage: node scripts/check-dependency-freshness.mjs [--out <path>] [--timeout-ms <ms>] [--attempts <n>]');
    index += 1;
  }
  return parsed;
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isNonRetryableHttpError(error) {
  return error instanceof Error && /^registry returned HTTP (?!408$|425$|429$|500$|502$|503$|504$)\d{3}$/.test(error.message);
}

function backoffMs(attempt) {
  return Math.min(MAX_BACKOFF_MS, 250 * (2 ** Math.max(0, attempt - 1)));
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function boundedOption(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return parsed;
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(requested, latest) {
  const left = parseVersion(requested);
  const right = parseVersion(latest);
  if (!left || !right) return 'unknown';
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return 'older';
    if (left[index] > right[index]) return 'newer';
  }
  return 'equal';
}

function versionDistance(requested, latest) {
  const left = parseVersion(requested);
  const right = parseVersion(latest);
  if (!left || !right) return undefined;
  if (left[0] !== right[0]) return 'major';
  if (left[1] !== right[1]) return 'minor';
  return 'patch';
}
