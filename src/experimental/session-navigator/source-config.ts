import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { catalogSourceId, catalogSourceLabel } from '@application/catalog/catalog-identity';
import { isKimiServerSourceRoot } from './kimi-server-journal';
import { isGenericFileProvider, type AuthorizedSourceSetting, type SessionNavigatorProviderId } from './types';

const PROVIDERS = new Set<SessionNavigatorProviderId>(['codex', 'claude', 'pi', 'kimi', 'gemini', 'opencode', 'agentsview', 'generic']);
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
  const piAgentRoot = env.PI_CODING_AGENT_DIR?.trim() || join(homeDirectory, '.pi', 'agent');
  const piSessionRoot = env.PI_CODING_AGENT_SESSION_DIR?.trim() || piAgentRoot;
  const candidates: Array<{ provider: SessionNavigatorProviderId; path: string | undefined; statePath?: string }> = [
    { provider: 'codex', path: codexRoot, statePath: codexStateRoot },
    { provider: 'claude', path: env.CLAUDE_CONFIG_DIR?.trim() || join(homeDirectory, '.claude') },
    { provider: 'pi', path: piSessionRoot },
    { provider: 'kimi', path: env.KIMI_CODE_HOME?.trim() || join(homeDirectory, '.kimi-code') },
    // Generic agent homes are opt-in through an explicit environment variable.
    // Never guess by walking the user's home directory.
    { provider: 'gemini', path: env.GEMINI_HOME?.trim() || env.GEMINI_CODE_HOME?.trim() },
    { provider: 'opencode', path: env.OPENCODE_HOME?.trim() },
    { provider: 'agentsview', path: env.AGENTSVIEW_HOME?.trim() || env.AGENTSVIEW_ROOT?.trim() || env.AGENT_VIEW_HOME?.trim() },
  ];
  return parseAuthorizedSources(candidates.flatMap(({ provider, path, statePath }) => {
    if (path === undefined || !isLocalFilesystemPath(path)) return [];
    // Kimi explicitly refuses a linked provider root. Check the original path
    // before realpath would erase its symlink identity.
    const isKimiRoot = provider === 'kimi';
    if (isKimiRoot && !isProviderRoot(provider, path)) return [];
    const canonicalPath = canonicalRoot(path);
    if (!isLocalFilesystemPath(canonicalPath)
      || (statePath !== undefined && (!isLocalFilesystemPath(statePath) || !isLocalFilesystemPath(canonicalRoot(statePath))))
      || (!isKimiRoot && !isProviderRoot(provider, canonicalPath))) return [];
    const stateRoot = provider === 'codex' && statePath !== undefined
      ? pathToFileURL(canonicalRoot(statePath)).toString()
      : undefined;
    return [{
      provider,
      rootUri: pathToFileURL(canonicalPath).toString(),
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
    candidate.provider === setting.provider && isUnderRoot(canonicalUriKey(setting.rootUri), canonicalUriKey(candidate.rootUri))
      && !(setting.provider === 'kimi' && isIndependentKimiServerRoot(setting.rootUri, candidate.rootUri)),
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
  return catalogSourceId(setting);
}

export function sourceLabelFor(setting: AuthorizedSourceSetting): string {
  return catalogSourceLabel(setting);
}

function isFileUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
    return isLocalFilesystemPath(fileURLToPath(parsed));
  } catch { return false; }
}

function isProviderRoot(provider: SessionNavigatorProviderId, path: string): boolean {
  try {
    if (!isLocalFilesystemPath(path)) return false;
    if (provider === 'kimi') {
      const root = lstatSync(path);
      if (!root.isDirectory() || root.isSymbolicLink()) return false;
      if (isKimiServerSourceRoot(path)) return true;
      const sessions = lstatSync(join(path, 'sessions'));
      return sessions.isDirectory() && !sessions.isSymbolicLink();
    }
    if (!statSync(path).isDirectory()) return false;
    const names = new Set(readdirSync(path, { encoding: 'utf8' }));
    if (provider === 'codex') {
      return [...names].some((name) => /^state(?:_\d+)?\.sqlite$/iu.test(name)) || names.has('sessions') || names.has('archived_sessions');
    }
    if (provider === 'pi') return names.has('sessions') || names.has('agent') || [...names].some((name) => name.endsWith('.jsonl'));
    if (isGenericFileProvider(provider)) {
      return names.has('projects') || names.has('history.jsonl') || names.has('sessions') || names.has('internal')
        || [...names].some((name) => name.endsWith('.jsonl'));
    }
    return names.has('projects') || names.has('history.jsonl') || names.has('sessions');
  } catch {
    return false;
  }
}

function isLocalFilesystemPath(path: string): boolean {
  return isAbsolute(path) && !/^[\\/]{2}/u.test(path);
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

function isIndependentKimiServerRoot(candidateUri: string, homeUri: string): boolean {
  const candidate = canonicalUriKey(candidateUri);
  const withinHome = relative(canonicalUriKey(homeUri), candidate).split(sep).join('/').toLowerCase();
  return withinHome === 'server' || withinHome === 'server/events' || isKimiServerSourceRoot(fileURLToPath(candidateUri));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
