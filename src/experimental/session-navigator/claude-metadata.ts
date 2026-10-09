import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { firstMetadataString as firstString, MetadataBudget, metadataText, readMetadataRecords, userMessagePreview } from './provider-metadata';

export interface ClaudeFile {
  path: string; relativePath: string; size: number; mtimeMs: number; parentSessionId?: string; parentSessionExists?: boolean; agentId?: string;
  parentAgentId?: string; parentAgentExists?: boolean; toolUseId?: string; agentType?: string; description?: string; sidecarSize?: number; sidecarMtimeMs?: number;
}
export interface ClaudeMetadata {
  nativeId: string; relativePath: string; vendorTitle?: string; firstMessagePreview?: string;
  startedAt?: string; activityAt: string; parentNativeId?: string; parentExists?: boolean; toolUseId?: string; agentType?: string; relationship: 'root' | 'subagent' | 'continuation';
}

interface ClaudeAgentSidecar {
  parentAgentId?: string; toolUseId?: string; agentType?: string; description?: string; size: number; mtimeMs: number;
}

const MAX_AGENT_SIDECAR_BYTES = 32 * 1024;
export interface ClaudeCollectionOptions { readonly readSidecars?: boolean }

/** Restrict discovery to provider transcript layouts; history/telemetry are not sessions. */
export async function collectClaudeFiles(rootPath: string, budget: MetadataBudget, pageOffset = 0, options: ClaudeCollectionOptions = {}): Promise<{ files: ClaudeFile[]; allFiles: ClaudeFile[]; truncated: boolean; hasMore: boolean }> {
  const root = resolve(rootPath);
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error('Session navigator refuses a symbolic-link source root.');
  const files: ClaudeFile[] = [];
  let visited = 0;
  let truncated = false;
  const offset = Math.max(0, Math.floor(pageOffset));
  const pageEnd = offset + Math.max(1, budget.limits.maxFiles);
  const maxEntries = Math.min(32_768, Math.max(2_048, pageEnd * 128));
  const accept = async (path: string, parentSessionId?: string, parentSessionExists?: boolean): Promise<void> => {
    if (!/\.(?:jsonl|ndjson)$/iu.test(path) || /\.orphaned-/iu.test(basename(path)) || ['history.jsonl', 'session_index.jsonl'].includes(basename(path))) return;
    const fileInfo = await optionalInfo(path);
    if (fileInfo === undefined) { truncated = true; return; }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return;
    const agentId = parentSessionId === undefined ? undefined : /^agent-(.+)\.jsonl$/u.exec(basename(path))?.[1];
    if (parentSessionId !== undefined && agentId === undefined) return;
    const sidecar = agentId === undefined ? undefined : options.readSidecars === false ? await statAgentSidecar(path) : await readAgentSidecar(path, budget);
    files.push({
      path, relativePath: info.isFile() ? basename(root) : relative(root, path), size: fileInfo.size, mtimeMs: fileInfo.mtimeMs,
      ...(parentSessionId === undefined ? {} : { parentSessionId }), ...(parentSessionExists === undefined ? {} : { parentSessionExists }),
      ...(agentId === undefined ? {} : { agentId }), ...(sidecar === undefined ? {} : {
        ...(sidecar.parentAgentId === undefined ? {} : { parentAgentId: sidecar.parentAgentId }),
        ...(sidecar.toolUseId === undefined ? {} : { toolUseId: sidecar.toolUseId }),
        ...(sidecar.agentType === undefined ? {} : { agentType: sidecar.agentType }),
        ...(sidecar.description === undefined ? {} : { description: sidecar.description }),
        sidecarSize: sidecar.size, sidecarMtimeMs: sidecar.mtimeMs,
      })
    });
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
  const agents = async (path: string, parent: string, depth = 0, knownParentSessionExists?: boolean): Promise<void> => {
    const parentTranscript = join(dirname(dirname(path)), parent + '.jsonl');
    const parentInfo = knownParentSessionExists === undefined ? await optionalInfo(parentTranscript) : undefined;
    const parentSessionExists = knownParentSessionExists ?? (parentInfo?.isFile() === true && !parentInfo.isSymbolicLink());
    for (const entry of await entries(path)) {
      if (!budget.check()) break;
      if (entry.isFile()) await accept(join(path, entry.name), parent, parentSessionExists);
      else if (entry.isDirectory() && depth < 3) await agents(join(path, entry.name), parent, depth + 1, parentSessionExists);
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
  const complete = !truncated && !budget.truncated;
  const agentKeys = new Set(files.flatMap((file) => file.agentId === undefined ? [] : [agentKey(file, file.agentId)]));
  const roots = new Set(files.filter((file) => file.parentSessionId === undefined).map((file) => sessionPathId(file)));
  const reconciled = files.map((file) => {
    if (file.parentAgentId === undefined) return file;
    const rootId = sessionPathId(file);
    const exists = file.parentAgentId === rootId || agentKeys.has(rootId + '\0' + file.parentAgentId) || roots.has(file.parentAgentId);
    return { ...file, ...(complete ? { parentAgentExists: exists } : {}) };
  });
  return { files: reconciled.slice(offset, pageEnd), allFiles: reconciled, truncated: truncated || budget.truncated || reconciled.length > pageEnd, hasMore: reconciled.length > pageEnd };
}

export async function readClaudeMetadata(file: ClaudeFile, budget: MetadataBudget): Promise<{ metadata?: ClaudeMetadata; sampled: boolean }> {
  const { values, sampled } = await readMetadataRecords(file.path, budget);
  const session = values.find((value) => firstString(value.sessionId, value.session_id) !== undefined || ['session', 'session_meta'].includes(String(value.type)));
  // A child has a provider identity in its path even when its first record exceeds
  // the sampling window. Keep that orphan discoverable without inventing a title.
  if (session === undefined && file.agentId === undefined && !values.some((value) => ['user', 'assistant', 'session', 'session_meta'].includes(String(value.type)))) return { sampled };
  const sessionId = firstString(session?.sessionId, session?.session_id, ['session', 'session_meta'].includes(String(session?.type)) ? session?.id : undefined) ?? basename(file.path, extname(file.path));
  const rootSessionId = file.parentSessionId ?? sessionId;
  const agentId = file.agentId ?? (session?.isSidechain === true ? firstString(session.agentId) : undefined);
  const nativeId = safeId(agentId === undefined ? sessionId : 'subagent:' + rootSessionId + ':' + agentId);
  const transcriptParent = firstString(session?.parentSessionId, session?.parent_session_id);
  const parentRaw = file.parentAgentId ?? file.parentSessionId ?? transcriptParent;
  const parentNativeId = file.parentAgentId === undefined
    ? (parentRaw === undefined ? undefined : safeId(parentRaw))
    : safeId(file.parentAgentId === rootSessionId ? rootSessionId : 'subagent:' + rootSessionId + ':' + file.parentAgentId);
  const parentExists = file.parentAgentId === undefined ? file.parentSessionExists : file.parentAgentExists;
  let vendorTitle: string | undefined;
  let summary: string | undefined;
  for (const value of values) {
    const title = metadataText(firstString(value.customTitle, value.sessionName, value.session_name, value.agentName, value.title));
    if (title !== undefined) vendorTitle = title;
    if (value.type === 'summary') summary = metadataText(firstString(value.summary));
  }
  vendorTitle ??= summary ?? file.description ?? file.agentType;
  const preview = values.map(userMessagePreview).find((value) => value !== undefined);
  const times = values.flatMap((value) => [value.timestamp, value.createdAt, value.created_at, value.updatedAt, value.updated_at]).map(normalizeMetadataTime).filter((value): value is string => value !== undefined);
  const startedAt = times[0];
  const activityAt = times.at(-1) ?? new Date(file.mtimeMs).toISOString();
  const metadata: ClaudeMetadata = {
    nativeId, relativePath: file.relativePath, activityAt,
    ...(vendorTitle === undefined ? {} : { vendorTitle }), ...(preview === undefined ? {} : { firstMessagePreview: preview }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(parentNativeId === undefined ? {} : { parentNativeId }),
    ...(parentExists === undefined ? {} : { parentExists }),
    ...(file.toolUseId === undefined ? {} : { toolUseId: file.toolUseId }),
    ...(file.agentType === undefined ? {} : { agentType: file.agentType }),
    relationship: agentId !== undefined || file.parentSessionId !== undefined ? 'subagent' : session?.relationship === 'continuation' ? 'continuation' : 'root',
  };
  return { metadata, sampled };
}

export function claudeFingerprint(files: readonly ClaudeFile[]): string { return createHash('sha256').update(files.map((file) => file.relativePath + '\0' + file.size + '\0' + file.mtimeMs + '\0' + (file.sidecarSize ?? '') + '\0' + (file.sidecarMtimeMs ?? '')).join('\n'), 'utf8').digest('hex'); }
async function optionalInfo(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
}
function safeId(value: string): string { return /^[A-Za-z0-9._:-]{1,256}$/u.test(value) ? value : 'id-' + createHash('sha256').update(value).digest('hex').slice(0, 20); }
function sessionPathId(file: ClaudeFile): string { return file.parentSessionId ?? basename(file.path, extname(file.path)); }
function agentKey(file: ClaudeFile, agentId: string): string { return sessionPathId(file) + '\0' + agentId; }
async function readAgentSidecar(transcriptPath: string, budget: MetadataBudget): Promise<ClaudeAgentSidecar | undefined> {
  const sidecarPath = agentSidecarPath(transcriptPath);
  const info = await optionalInfo(sidecarPath);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) return undefined;
  // Keep the sidecar identity in the source fingerprint even when a crashed
  // writer left invalid JSON or a future version exceeds our bounded read cap.
  if (info.size > MAX_AGENT_SIDECAR_BYTES || !budget.available()) return { size: info.size, mtimeMs: info.mtimeMs };
  const remaining = Math.min(info.size, MAX_AGENT_SIDECAR_BYTES, Math.max(0, budget.limits.maxBytes - budget.bytes));
  if (remaining <= 0) { budget.truncated = true; return undefined; }
  const handle = await open(sidecarPath, 'r');
  try {
    const buffer = Buffer.alloc(remaining);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    budget.bytes += bytesRead;
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { return { size: info.size, mtimeMs: info.mtimeMs }; }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { size: info.size, mtimeMs: info.mtimeMs };
    const record = value as Record<string, unknown>;
    const parentAgentId = boundedId(firstString(record.parentAgentId));
    const toolUseId = boundedId(firstString(record.toolUseId));
    const agentType = metadataText(firstString(record.agentType), 80);
    const description = metadataText(firstString(record.description, record.task), 240);
    return {
      ...(parentAgentId === undefined ? {} : { parentAgentId }),
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(agentType === undefined ? {} : { agentType }),
      ...(description === undefined ? {} : { description }),
      size: info.size, mtimeMs: info.mtimeMs,
    };
  } finally { await handle.close(); }
}
async function statAgentSidecar(transcriptPath: string): Promise<ClaudeAgentSidecar | undefined> {
  const info = await optionalInfo(agentSidecarPath(transcriptPath));
  return info === undefined || !info.isFile() || info.isSymbolicLink() ? undefined : { size: info.size, mtimeMs: info.mtimeMs };
}
function agentSidecarPath(transcriptPath: string): string { return transcriptPath.replace(/\.jsonl$/iu, '.meta.json'); }
function boundedId(value: string | undefined): string | undefined { const text = value?.trim(); return text === undefined || text.length === 0 ? undefined : text.slice(0, 256); }
export function normalizeMetadataTime(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(typeof value === 'number' && Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
