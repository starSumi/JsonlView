import { DISTRIBUTION_FILES } from './bundle-integrity.mjs';

/**
 * Static files that are intentionally shared by both registry-targeted VSIX
 * candidates. Runtime bundle and native entries are listed separately below
 * so this policy remains explicit without duplicating the bundle inventory.
 */
export const VSIX_PUBLIC_FILES = Object.freeze([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE.txt',
  'THIRD-PARTY-NOTICES.txt',
  'package.nls.json',
  'images/jsonlview-icon.png',
  'docs/format-and-profile-boundaries.md',
]);

/** Exact README showcase assets retained in public VSIX and npm packages. */
export const VSIX_PUBLIC_ASSETS = Object.freeze([
  'docs/assets/claude-diff.png',
  'docs/assets/codex-timeline-exec.png',
  'docs/assets/paste-jsonl-source.png',
  'docs/assets/pi-system-prompt.png',
  'docs/assets/rollout-event-insights.png',
  'docs/assets/session-navigator-opt-in.png',
]);

export const VSIX_FORBIDDEN_PREFIXES = Object.freeze([
  'src/',
  'test/',
  'scripts/',
  '.github/',
  'report/',
  'state/',
  'docs/decisions/',
  'docs/metadata/',
  'docs/internal/',
]);

export const VSIX_REQUIRED_FILES = Object.freeze([
  ...VSIX_PUBLIC_FILES,
  ...VSIX_PUBLIC_ASSETS,
  ...DISTRIBUTION_FILES.map((path) => `dist/${path}`),
  'native/jsonl-core/jsonl_core.win32-x64-msvc.node',
  'native/jsonl-core/index.d.ts',
  'native/jsonl-core/package.json',
]);

const VSIX_ALLOWED_PREFIXES = Object.freeze([
  'third_party/licenses/',
]);

const FORBIDDEN_FILE_PATTERN = /(?:^|\/)(?:\.vscodeignore|Cargo(?:\.lock|\.toml)?|build\.rs|\.env(?:\..*)?|\.npmrc|.*\.(?:pem|key|p12|pfx)|.*\.provenance\.json)$/iu;
const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/iu;
const SENSITIVE_NAME_PATTERN = /(?:^|\/)(?:fixtures?|transcripts?|recordings?)(?:\/|\.|$)|(?:^|\/)[^/]*\.(?:transcript|fixture)(?:\.[^/]*)?$/iu;
const CREDENTIAL_NAME_PATTERN = /(?:^|\/)(?:credentials?|secrets?|tokens?)(?:[-_.]|\/|$)/iu;

/** Normalize both staging-relative and VSIX archive paths to one contract. */
export function normalizeVsixPath(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized.startsWith('extension/')) return normalized.slice('extension/'.length);
  return normalized;
}

/** Return the policy path in the archive's virtual `extension/` namespace. */
export function toVsixArchivePath(value) {
  const normalized = normalizeVsixPath(value);
  return normalized === undefined ? undefined : `extension/${normalized}`;
}

export function isVsixPathForbidden(value) {
  const path = normalizeVsixPath(value);
  if (path === undefined || path.length === 0) return true;
  const folded = path.toLowerCase();
  return VSIX_FORBIDDEN_PREFIXES.some((prefix) => folded.startsWith(prefix))
    || FORBIDDEN_FILE_PATTERN.test(path)
    || TEST_FILE_PATTERN.test(path)
    || SENSITIVE_NAME_PATTERN.test(path)
    || CREDENTIAL_NAME_PATTERN.test(path);
}

export function isVsixPathAllowed(value) {
  const path = normalizeVsixPath(value);
  if (path === undefined || isVsixPathForbidden(path)) return false;
  const folded = path.toLowerCase();
  if (VSIX_PUBLIC_FILES.some((entry) => entry.toLowerCase() === folded)) return true;
  if (VSIX_PUBLIC_ASSETS.some((entry) => entry.toLowerCase() === folded)) return true;
  if (DISTRIBUTION_FILES.some((entry) => `dist/${entry}` === folded)) return true;
  if ([
    'native/jsonl-core/jsonl_core.win32-x64-msvc.node',
    'native/jsonl-core/index.d.ts',
    'native/jsonl-core/package.json',
  ].includes(folded)) return true;
  return VSIX_ALLOWED_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

/** Return normalized paths that violate either the deny or allow contract. */
export function findVsixPolicyViolations(paths) {
  if (!Array.isArray(paths)) return ['<missing-inventory>'];
  return [...new Set(paths
    .map((path) => normalizeVsixPath(path))
    .filter((path) => path === undefined || !isVsixPathAllowed(path))
    .map((path) => path ?? '<invalid-path>'))].sort(stableCompare);
}

export function findForbiddenVsixPaths(paths) {
  if (!Array.isArray(paths)) return ['<missing-inventory>'];
  return [...new Set(paths
    .filter((path) => isVsixPathForbidden(path))
    .map((path) => normalizeVsixPath(path) ?? '<invalid-path>'))].sort(stableCompare);
}

export function missingVsixRequiredFiles(paths) {
  if (!Array.isArray(paths)) return [...VSIX_REQUIRED_FILES];
  const present = new Set(paths.map((path) => normalizeVsixPath(path)).filter((path) => path !== undefined));
  return VSIX_REQUIRED_FILES.filter((path) => !present.has(path));
}

/**
 * Project README links for a narrow public artifact while leaving the source
 * README untouched. Retained docs and showcase images stay package-relative;
 * links to repository docs outside the artifact point to the exact source
 * commit so they remain navigable without widening the package payload.
 */
export function projectArtifactReadme(readme, { repositoryUrl, commitSha, allowedPaths }) {
  if (typeof readme !== 'string') throw new TypeError('README content must be a string.');
  const sourceBase = githubBlobBase(repositoryUrl, commitSha);
  const allowed = new Set(allowedPaths.map(normalizeReadmePath));
  return readme.replace(/(!?)\[([^\]]*)\]\((docs\/[^)\s]+)([^)]*)\)/g, (whole, imageMarker, label, target, suffix) => {
    const normalizedTarget = normalizeReadmePath(target);
    if (allowed.has(normalizedTarget)) return whole;
    if (imageMarker === '!') {
      throw new Error(`README references an image outside the artifact allowlist: ${target}`);
    }
    const encodedTarget = normalizedTarget.split('/').map(encodeURIComponent).join('/');
    return `[${label}](${sourceBase}${encodedTarget}${suffix})`;
  });
}

function githubBlobBase(repositoryUrl, commitSha) {
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/iu.test(commitSha)) {
    throw new Error('README repository links require a full 40-character source commit SHA.');
  }
  if (typeof repositoryUrl !== 'string' || repositoryUrl.trim().length === 0) {
    throw new Error('README repository links require package repository metadata.');
  }
  const normalizedUrl = repositoryUrl.trim().replace(/^git\+https:/iu, 'https:').replace(/\.git$/iu, '');
  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch (error) {
    throw new Error('README repository links require a valid HTTPS GitHub repository URL.', { cause: error });
  }
  const segments = parsed.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.port.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0
    || segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
    throw new Error('README repository links require a valid HTTPS GitHub owner/repository URL.');
  }
  return `https://github.com/${segments[0]}/${segments[1]}/blob/${commitSha}/`;
}

function normalizeReadmePath(path) {
  if (typeof path !== 'string') return '';
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
