import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { firstMetadataString as firstString, MetadataBudget, metadataText, readMetadataRecords, userMessagePreview } from './provider-metadata';

export interface ClaudeFile { path: string; relativePath: string; size: number; mtimeMs: number; parentSessionId?: string; agentId?: string }
export interface ClaudeMetadata {
  nativeId: string; relativePath: string; vendorTitle?: string; firstMessagePreview?: string;
  startedAt?: string; activityAt: string; parentNativeId?: string; relationship: 'root' | 'subagent' | 'continuation';
}

/** Restrict discovery to provider transcript layouts; history/telemetry are not sessions. */
export async function collectClaudeFiles(rootPath: string, budget: MetadataBudget, pageOffset = 0): Promise<{ files: ClaudeFile[]; allFiles: ClaudeFile[]; truncated: boolean; hasMore: boolean }> {
  const root = resolve(rootPath);
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error('Session navigator refuses a symbolic-link source root.');
  const files: ClaudeFile[] = [];
  let visited = 0;
  let truncated = false;
  const offset = Math.max(0, Math.floor(pageOffset));
  const pageEnd = offset + Math.max(1, budget.limits.maxFiles);
  const maxEntries = Math.min(32_768, Math.max(2_048, pageEnd * 128));
  const accept = async (path: string, parentSessionId?: string): Promise<void> => {
    if (!/\.(?:jsonl|ndjson)$/iu.test(path) || /\.orphaned-/iu.test(basename(path)) || ['history.jsonl', 'session_index.jsonl'].includes(basename(path))) return;
    const fileInfo = await optionalInfo(path);
    if (fileInfo === undefined) { truncated = true; return; }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return;
    const agentId = parentSessionId === undefined ? undefined : /^agent-(.+)\.jsonl$/u.exec(basename(path))?.[1];
    if (parentSessionId !== undefined && agentId === undefined) return;
    files.push({ path, relativePath: info.isFile() ? basename(root) : relative(root, path), size: fileInfo.size, mtimeMs: fileInfo.mtimeMs, ...(parentSessionId === undefined ? {} : { parentSessionId }), ...(agentId === undefined ? {} : { agentId }) });
  };
  const entries = async (path: string) => {
    if (!budget.check() || visited >= maxEntries) { truncated = true; return []; }
    const found = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' && path !== root) { truncated = true; return []; }
      throw error;
    });
    visited += found.length;
    if (visited > maxEntries) truncated = true;
    return found.slice(0, Math.max(0, maxEntries - (visited - found.length))).filter((entry) => !entry.isSymbolicLink());
  };
  const agents = async (path: string, parent: string, depth = 0): Promise<void> => {
    for (const entry of await entries(path)) {
      if (!budget.check()) break;
      if (entry.isFile()) await accept(join(path, entry.name), parent);
      else if (entry.isDirectory() && depth < 3) await agents(join(path, entry.name), parent, depth + 1);
    }
  };
  const project = async (path: string): Promise<void> => {
    for (const entry of await entries(path)) {
      if (!budget.check()) break;
      if (entry.isFile()) await accept(join(path, entry.name));
      else if (entry.isDirectory()) {
        const subagents = join(path, entry.name, 'subagents');
        const subInfo = await optionalInfo(subagents);
        if (subInfo?.isDirectory() && !subInfo.isSymbolicLink()) await agents(subagents, entry.name);
      }
    }
  };
  if (info.isFile()) {
    const parts = root.split(/[\\/]/u);
    const subagents = parts.lastIndexOf('subagents');
    await accept(root, subagents > 0 ? parts[subagents - 1] : undefined);
  } else {
    const projects = join(root, 'projects');
    const projectsInfo = await optionalInfo(projects);
    const projectRoot = projectsInfo?.isDirectory() && !projectsInfo.isSymbolicLink() ? projects : basename(root) === 'projects' ? root : undefined;
    if (projectRoot !== undefined) {
      for (const entry of await entries(projectRoot)) if (entry.isDirectory() && budget.check()) await project(join(projectRoot, entry.name));
    } else if (basename(root) === 'subagents') await agents(root, basename(dirname(root)));
    else await project(root);
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath));
  return { files: files.slice(offset, pageEnd), allFiles: files, truncated: truncated || budget.truncated || files.length > pageEnd, hasMore: files.length > pageEnd };
}

export async function readClaudeMetadata(file: ClaudeFile, budget: MetadataBudget): Promise<{ metadata?: ClaudeMetadata; sampled: boolean }> {
  const { values, sampled } = await readMetadataRecords(file.path, budget);
  const session = values.find((value) => firstString(value.sessionId, value.session_id) !== undefined || ['session', 'session_meta'].includes(String(value.type)));
  // A child has a provider identity in its path even when its first record exceeds
  // the sampling window. Keep that orphan discoverable without inventing a title.
  if (session === undefined && file.agentId === undefined && !values.some((value) => ['user', 'assistant', 'session', 'session_meta'].includes(String(value.type)))) return { sampled };
  const sessionId = firstString(session?.sessionId, session?.session_id, ['session', 'session_meta'].includes(String(session?.type)) ? session?.id : undefined) ?? basename(file.path, extname(file.path));
  const parentRaw = file.parentSessionId ?? firstString(session?.parentSessionId, session?.parent_session_id);
  const agentId = file.agentId ?? (session?.isSidechain === true ? firstString(session.agentId) : undefined);
  const nativeId = safeId(agentId === undefined ? sessionId : 'subagent:' + (parentRaw ?? sessionId) + ':' + agentId);
  let vendorTitle: string | undefined;
  let summary: string | undefined;
  for (const value of values) {
    const title = metadataText(firstString(value.customTitle, value.sessionName, value.session_name, value.agentName, value.title));
    if (title !== undefined) vendorTitle = title;
    if (value.type === 'summary') summary = metadataText(firstString(value.summary));
  }
  vendorTitle ??= summary;
  const preview = values.map(userMessagePreview).find((value) => value !== undefined);
  const times = values.flatMap((value) => [value.timestamp, value.createdAt, value.created_at, value.updatedAt, value.updated_at]).map(normalizeMetadataTime).filter((value): value is string => value !== undefined);
  const startedAt = times[0];
  const activityAt = times.at(-1) ?? new Date(file.mtimeMs).toISOString();
  const metadata: ClaudeMetadata = {
    nativeId, relativePath: file.relativePath, activityAt,
    ...(vendorTitle === undefined ? {} : { vendorTitle }), ...(preview === undefined ? {} : { firstMessagePreview: preview }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(parentRaw === undefined ? {} : { parentNativeId: safeId(parentRaw) }),
    relationship: agentId !== undefined || file.parentSessionId !== undefined ? 'subagent' : session?.relationship === 'continuation' ? 'continuation' : 'root',
  };
  return { metadata, sampled };
}

export function claudeFingerprint(files: readonly ClaudeFile[]): string { return createHash('sha256').update(files.map((file) => file.relativePath + '\0' + file.size + '\0' + file.mtimeMs).join('\n'), 'utf8').digest('hex'); }
async function optionalInfo(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
}
function safeId(value: string): string { return /^[A-Za-z0-9._:-]{1,256}$/u.test(value) ? value : 'id-' + createHash('sha256').update(value).digest('hex').slice(0, 20); }
export function normalizeMetadataTime(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(typeof value === 'number' && Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
