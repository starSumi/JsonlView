import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CatalogNavigatorSourceSetting, CatalogSourceKind } from './catalog-model';

export function catalogSourceId(setting: CatalogNavigatorSourceSetting): string {
  const identity = setting.provider + '\0' + canonicalUriKey(setting.rootUri) + '\0' + canonicalUriKey(setting.stateRootUri ?? setting.rootUri);
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex');
  return setting.provider + '-' + digest.slice(0, 24);
}

export function catalogSourceLabel(setting: CatalogNavigatorSourceSetting): string {
  try {
    let path = decodeURIComponent(new URL(setting.rootUri).pathname);
    while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const name = path.split('/').filter(Boolean).at(-1);
    return name && name.length > 0 ? setting.provider + ': ' + name : setting.provider + ' source';
  } catch {
    return setting.provider + ' source';
  }
}

export function catalogSourceKind(setting: CatalogNavigatorSourceSetting): CatalogSourceKind {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(setting.rootUri).pathname).toLowerCase(); } catch { /* use provider fallback */ }
  if (pathname.endsWith('.jsonl') || pathname.endsWith('.ndjson')) return 'exact_file';
  return setting.provider === 'generic' ? 'folder' : 'provider_home';
}

function canonicalUriKey(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return uri;
    const path = fileURLToPath(parsed);
    try { return realpathSync.native(path); } catch { return path; }
  } catch {
    return uri;
  }
}
