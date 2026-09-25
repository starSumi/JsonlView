import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const TARGET_PATH = resolve(root, 'config/release-targets.json');
const EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const PUBLISHER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const releaseTargets = JSON.parse(readFileSync(TARGET_PATH, 'utf8'));
const startupIssues = validateReleaseTargets(releaseTargets);
if (startupIssues.length > 0) throw new Error(`invalid release target contract: ${startupIssues.join('; ')}`);

export async function loadReleaseTargets() {
  return structuredClone(releaseTargets);
}

export async function resolveExtensionTarget(key) {
  return getExtensionTarget(key);
}

export function getReleaseTargets() {
  return structuredClone(releaseTargets);
}

export function getExtensionTarget(key) {
  const target = releaseTargets.extensions[key];
  if (target === undefined) {
    throw new Error(`unknown extension release target: ${String(key)}`);
  }
  return { key, ...target };
}

export function validateReleaseTargets(value) {
  const issues = [];
  if (!isRecord(value) || value.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  const source = isRecord(value?.sourceManifest) ? value.sourceManifest : {};
  if (!EXTENSION_NAME.test(source.name ?? '')) issues.push('sourceManifest.name is invalid');
  if (!PUBLISHER.test(source.publisher ?? '')) issues.push('sourceManifest.publisher is invalid');
  if (!NPM_NAME.test(value?.npm?.name ?? '')) issues.push('npm.name is invalid');

  const extensions = isRecord(value?.extensions) ? value.extensions : {};
  const expectedTargets = {
    'open-vsx': { registry: 'open-vsx', preservesUpdateChain: true },
    marketplace: { registry: 'visual-studio-marketplace', preservesUpdateChain: false },
  };
  const actualTargetKeys = Object.keys(extensions).sort();
  const expectedTargetKeys = Object.keys(expectedTargets).sort();
  if (JSON.stringify(actualTargetKeys) !== JSON.stringify(expectedTargetKeys)) {
    issues.push(`extensions keys must be exactly ${expectedTargetKeys.join(', ')}`);
  }
  for (const [key, expected] of Object.entries(expectedTargets)) {
    const target = extensions[key];
    if (!isRecord(target)) {
      issues.push(`extensions.${key} is missing`);
      continue;
    }
    if (!EXTENSION_NAME.test(target.name ?? '')) issues.push(`extensions.${key}.name is invalid`);
    if (!PUBLISHER.test(target.publisher ?? '')) issues.push(`extensions.${key}.publisher is invalid`);
    if (typeof target.displayName !== 'string' || target.displayName.trim().length === 0) {
      issues.push(`extensions.${key}.displayName is invalid`);
    }
    if (target.registry !== expected.registry) issues.push(`extensions.${key}.registry must be ${expected.registry}`);
    if (target.preservesUpdateChain !== expected.preservesUpdateChain) {
      issues.push(`extensions.${key}.preservesUpdateChain must be ${String(expected.preservesUpdateChain)}`);
    }
  }
  const openVsx = extensions['open-vsx'];
  if (isRecord(openVsx) && (openVsx.name !== source.name || openVsx.publisher !== source.publisher)) {
    issues.push('open-vsx must preserve sourceManifest publisher and name');
  }
  const ids = Object.values(extensions)
    .filter(isRecord)
    .map((target) => `${target.publisher}.${target.name}`.toLowerCase());
  if (ids.length !== new Set(ids).size) issues.push('extension targets must have distinct extension ids');
  if (!Array.isArray(value?.sharedContributionIds) || value.sharedContributionIds.length === 0) {
    issues.push('sharedContributionIds must be a non-empty array');
  } else if (value.sharedContributionIds.some((id) => typeof id !== 'string' || !id.startsWith('jsonlView.'))) {
    issues.push('sharedContributionIds contains an invalid id');
  }
  if (value?.coInstallSupported !== false) issues.push('coInstallSupported must remain false while contribution ids are shared');
  return issues;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
