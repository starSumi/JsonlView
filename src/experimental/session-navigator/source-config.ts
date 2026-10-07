import { createHash } from 'node:crypto';
import type { AuthorizedSourceSetting, SessionNavigatorProviderId } from './types';

const PROVIDERS = new Set<SessionNavigatorProviderId>(['codex', 'claude', 'generic']);
const MAX_ROOT_URI_LENGTH = 2_048;

export function parseAuthorizedSources(value: unknown): readonly AuthorizedSourceSetting[] {
  if (!Array.isArray(value)) return [];
  const result: AuthorizedSourceSetting[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.provider !== 'string' || !PROVIDERS.has(candidate.provider as SessionNavigatorProviderId)) continue;
    if (typeof candidate.rootUri !== 'string' || !isFileUri(candidate.rootUri)) continue;
    const rootUri = candidate.rootUri.trim();
    if (rootUri.length === 0 || rootUri.length > MAX_ROOT_URI_LENGTH) continue;
    const key = `${candidate.provider}\0${rootUri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ provider: candidate.provider as SessionNavigatorProviderId, rootUri });
  }
  return Object.freeze(result);
}

export function sourceIdFor(setting: AuthorizedSourceSetting): string {
  const digest = createHash('sha256').update(`${setting.provider}\0${setting.rootUri}`, 'utf8').digest('hex');
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
  return value.startsWith('file://');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
