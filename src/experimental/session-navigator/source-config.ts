import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AuthorizedSourceSetting, SessionNavigatorProviderId } from './types';

const PROVIDERS = new Set<SessionNavigatorProviderId>(['codex', 'claude', 'generic']);
const MAX_ROOT_URI_LENGTH = 2_048;

export interface DefaultSourceDiscoveryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}

export function parseAuthorizedSources(value: unknown): readonly AuthorizedSourceSetting[] {
  if (!Array.isArray(value)) return [];
  const result: AuthorizedSourceSetting[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.provider !== 'string' || !PROVIDERS.has(candidate.provider as SessionNavigatorProviderId)) continue;
    if (typeof candidate.rootUri !== 'string' || !isFileUri(candidate.rootUri)) continue;
    const rootUri = candidate.rootUri.trim();
    if (rootUri.length === 0 || rootUri.length > MAX_ROOT_URI_LENGTH) continue;
    if (candidate.stateRootUri !== undefined && (typeof candidate.stateRootUri !== 'string' || !isFileUri(candidate.stateRootUri))) continue;
    const stateRootUri = typeof candidate.stateRootUri === 'string' && isFileUri(candidate.stateRootUri)
      ? candidate.stateRootUri.trim()
      : undefined;
    if (stateRootUri !== undefined && (stateRootUri.length === 0 || stateRootUri.length > MAX_ROOT_URI_LENGTH)) continue;
    const key = `${candidate.provider}\0${rootUri}\0${stateRootUri ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      provider: candidate.provider as SessionNavigatorProviderId,
      rootUri,
      ...(stateRootUri === undefined ? {} : { stateRootUri }),
    });
  }
  return Object.freeze(result);
}

/** Resolve only provider-owned default roots; never walk arbitrary home files. */
export function discoverDefaultSources(options: DefaultSourceDiscoveryOptions = {}): readonly AuthorizedSourceSetting[] {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const codexRoot = env.CODEX_HOME?.trim() || join(homeDirectory, '.codex');
  const codexStateRoot = env.CODEX_SQLITE_HOME?.trim() || codexRoot;
  const candidates: Array<{ provider: SessionNavigatorProviderId; path: string | undefined; statePath?: string }> = [
    { provider: 'codex', path: codexRoot, statePath: codexStateRoot },
    { provider: 'claude', path: env.CLAUDE_CONFIG_DIR?.trim() || join(homeDirectory, '.claude') },
  ];
  return parseAuthorizedSources(candidates.flatMap(({ provider, path, statePath }) => {
    if (path === undefined || !isProviderRoot(provider, path)) return [];
    const stateRoot = provider === 'codex' && statePath !== undefined
      ? pathToFileURL(canonicalRoot(statePath)).toString()
      : undefined;
    return [{
      provider,
      rootUri: pathToFileURL(canonicalRoot(path)).toString(),
      ...(stateRoot === undefined ? {} : { stateRootUri: stateRoot }),
    }];
  }));
}

export function mergeSourceSettings(
  configured: readonly AuthorizedSourceSetting[],
  discovered: readonly AuthorizedSourceSetting[] = discoverDefaultSources(),
): readonly AuthorizedSourceSetting[] {
  const result: AuthorizedSourceSetting[] = [];
  const seen = new Set<string>();
  // A detected provider home supersedes old entries pointing at its sessions or
  // individual rollouts. Custom homes elsewhere remain independent sources.
  const defaults = discovered.map((setting) => configured.find((candidate) =>
    candidate.provider === setting.provider && candidate.stateRootUri !== undefined && canonicalUriKey(candidate.rootUri) === canonicalUriKey(setting.rootUri),
  ) ?? setting);
  const candidates = [...defaults, ...configured.filter((setting) => !discovered.some((candidate) =>
    candidate.provider === setting.provider && isUnderRoot(canonicalUriKey(setting.rootUri), canonicalUriKey(candidate.rootUri)),
  ))];
  for (const setting of candidates) {
    const key = setting.provider + '\0' + canonicalUriKey(setting.rootUri) + '\0' + canonicalUriKey(setting.stateRootUri ?? setting.rootUri);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(setting);
  }
  return Object.freeze(result);
}

export function sourceIdFor(setting: AuthorizedSourceSetting): string {
  const digest = createHash('sha256').update(setting.provider + '\0' + canonicalUriKey(setting.rootUri) + '\0' + canonicalUriKey(setting.stateRootUri ?? setting.rootUri), 'utf8').digest('hex');
  return `${setting.provider}-${digest.slice(0, 24)}`;
}

export function sourceLabelFor(setting: AuthorizedSourceSetting): string {
  try {
    const parsed = new URL(setting.rootUri);
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/u, '');
    const name = path.split('/').filter(Boolean).at(-1);
    return name && name.length > 0 ? `${setting.provider}: ${name}` : `${setting.provider} source`;
  } catch {
    return `${setting.provider} source`;
  }
}

function isFileUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'file:' && isAbsolute(fileURLToPath(parsed));
  } catch { return false; }
}

function isProviderRoot(provider: SessionNavigatorProviderId, path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    const names = new Set(readdirSync(path, { encoding: 'utf8' }));
    if (provider === 'codex') {
      return [...names].some((name) => /^state(?:_\d+)?\.sqlite$/iu.test(name)) || names.has('sessions') || names.has('archived_sessions');
    }
    return names.has('projects') || names.has('history.jsonl') || names.has('sessions');
  } catch {
    return false;
  }
}

function canonicalRoot(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

function canonicalUriKey(uri: string): string {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'file:' ? canonicalRoot(fileURLToPath(parsed)) : uri;
  } catch {
    return uri;
  }
}

function isUnderRoot(candidate: string, root: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
