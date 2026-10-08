import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { NavigationEntity, NavigationRelation } from '../navigation-contract';
import { collectFiles, FileSessionNavigatorProvider } from './file-provider';
import { sourceIdFor } from './source-config';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET, type AuthorizedSourceSetting, type NavigatorLocation, type NavigatorSnapshot, type SessionNavigatorBudget, type SessionNavigatorProvider, type SessionNavigatorProviderId, type SessionNavigatorScanResult } from './types';

const MAX_TITLE_LENGTH = 160;
const MAX_PREVIEW_LENGTH = 240;

export function createNativeSessionNavigatorProvider(setting: AuthorizedSourceSetting): SessionNavigatorProvider {
  const sourceId = sourceIdFor(setting);
  if (setting.provider === 'codex') return new CodexSessionNavigatorProvider(setting, sourceId);
  if (setting.provider === 'claude') return new ClaudeSessionNavigatorProvider(setting, sourceId);
  return new FileSessionNavigatorProvider(setting, sourceId);
}

abstract class NativeSessionNavigatorProvider implements SessionNavigatorProvider {
  public readonly sourceId: string;
  public readonly provider: SessionNavigatorProviderId;
  public readonly rootUri: string;
  protected readonly rootPath: string;

  public constructor(setting: AuthorizedSourceSetting, sourceId: string) {
    const parsed = new URL(setting.rootUri);
    if (parsed.protocol !== 'file:') throw new Error('Session navigator sources must use file URIs.');
    this.sourceId = sourceId;
    this.provider = setting.provider;
    this.rootUri = setting.rootUri;
    this.rootPath = fileURLToPath(parsed);
  }

  public abstract scan(signal: AbortSignal, budget: SessionNavigatorBudget): Promise<SessionNavigatorScanResult>;
  public abstract probe(signal: AbortSignal): Promise<string>;

  public async readSnapshot(signal: AbortSignal, budget: Required<import('../navigation-contract').NavigationBudget>): Promise<NavigatorSnapshot> {
    const result = await this.scan(signal, {
      maxEntities: budget.maxEntities,
      maxRelations: budget.maxRelations,
      maxRecords: budget.maxRecords,
      maxFiles: 64,
      maxBytes: 16 * 1024 * 1024,
      maxMilliseconds: budget.maxMilliseconds,
    });
    return result.snapshot;
  }

  protected snapshot(entities: NavigationEntity[], relations: NavigationRelation[], locations: NavigatorLocation[], capturedAt: string, truncated = false): NavigatorSnapshot {
    const generation = 'scan-' + createHash('sha256').update(this.sourceId + '\0' + capturedAt + '\0' + String(entities.length) + '\0' + String(relations.length), 'utf8').digest('hex').slice(0, 24);
    return Object.freeze({
      schemaVersion: 1,
      provider: this.provider,
      snapshotId: 'scan-' + this.sourceId + '-' + generation,
      sourceId: this.sourceId,
      sourceGeneration: generation,
      capturedAt,
      redaction: 'metadata-only',
      entities: Object.freeze(entities.map((entity) => Object.freeze({ ...entity, sourceId: this.sourceId }))),
      relations: Object.freeze(relations.map((relation) => Object.freeze({ ...relation, sourceId: this.sourceId }))),
      locations: Object.freeze(locations.map((location) => Object.freeze({ ...location }))),
      truncated,
      ...(truncated ? { truncatedReason: 'record_limit' as const } : {}),
    });
  }

}

class CodexSessionNavigatorProvider extends NativeSessionNavigatorProvider {
  private readonly stateRootPath: string;

  public constructor(setting: AuthorizedSourceSetting, sourceId: string) {
    super(setting, sourceId);
    this.stateRootPath = setting.stateRootUri === undefined
      ? this.rootPath
      : fileURLToPath(new URL(setting.stateRootUri));
  }

  public async probe(signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const statePath = await findCodexStatePath(this.stateRootPath);
    if (statePath === undefined) throw new Error('Codex state database was not found under the provider home.');
    const parts = [await fileFingerprint(statePath)];
    const walPath = statePath + '-wal';
    const wal = await stat(walPath).catch(() => undefined);
    parts.push(wal === undefined ? 'wal:absent' : walPath + '\0' + wal.size + '\0' + wal.mtimeMs);
    const indexPath = join(resolveCodexHome(this.rootPath), 'session_index.jsonl');
    if (existsSync(indexPath)) parts.push(await fileFingerprint(indexPath));
    const rolloutRoot = resolveRootPath(this.rootPath);
    for (const directory of ['sessions', 'archived_sessions']) {
      try {
        const files = await collectFiles(join(rolloutRoot, directory), signal, { ...DEFAULT_SESSION_NAVIGATOR_BUDGET, maxFiles: 32, maxMilliseconds: 750 }, Date.now());
        parts.push(...files.map((file) => file.path + '\0' + file.size.toString() + '\0' + String(file.mtimeMs)));
      } catch {
        // A missing optional archive directory does not invalidate the state fingerprint.
      }
    }
    return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
  }

  public async scan(signal: AbortSignal, budget: SessionNavigatorBudget): Promise<SessionNavigatorScanResult> {
    throwIfAborted(signal);
    const fingerprint = await this.probe(signal);
    const statePath = await findCodexStatePath(this.stateRootPath);
    if (statePath === undefined) throw new Error('Codex state database was not found under the provider home.');
    const db = await openReadOnlyDatabase(statePath);
    if (db === undefined) throw new Error('Codex state database could not be opened read-only.');
    try {
      const titles = await readCodexTitles(join(resolveCodexHome(this.rootPath), 'session_index.jsonl'), budget, signal);
      db.exec('BEGIN');
      let snapshot: NavigatorSnapshot;
      try {
        snapshot = readCodexSnapshot(db, this.rootPath, this.sourceId, budget, signal, titles);
      } finally {
        db.exec('ROLLBACK');
      }
      if (fingerprint !== await this.probe(signal)) throw new Error('Codex metadata changed during the scan. Refresh to retry.');
      return { snapshot, fingerprint };
    } finally {
      db.close();
    }
  }
}

class ClaudeSessionNavigatorProvider extends NativeSessionNavigatorProvider {
  public async probe(signal: AbortSignal): Promise<string> {
    const files = await collectFiles(this.rootPath, signal, { ...DEFAULT_SESSION_NAVIGATOR_BUDGET, maxFiles: 64 }, Date.now());
    return createHash('sha256').update(files.map((file) => file.relativePath + '\0' + file.size + '\0' + file.mtimeMs).join('\n'), 'utf8').digest('hex');
  }

  public async scan(signal: AbortSignal, budget: SessionNavigatorBudget): Promise<SessionNavigatorScanResult> {
    const started = Date.now();
    const files = await collectFiles(this.rootPath, signal, budget, started);
    const pending: PendingClaudeSession[] = [];
    let bytes = 0;
    let truncated = false;
    for (const file of files) {
      throwIfAborted(signal);
      if (Date.now() - started >= budget.maxMilliseconds || pending.length >= budget.maxEntities) { truncated = true; break; }
      if (file.size > BigInt(4 * 1024 * 1024) || bytes + Number(file.size) > budget.maxBytes) { truncated = true; continue; }
      bytes += Number(file.size);
      const text = new TextDecoder().decode(await readFile(file.path));
      pending.push(parseClaudeFile(text, file.relativePath, file.mtimeMs));
    }
    const ids = new Set(pending.map((item) => item.nativeId));
    const entities: NavigationEntity[] = [];
    const relations: NavigationRelation[] = [];
    const locations: NavigatorLocation[] = [];
    for (const item of pending) {
      const orphan = item.parentNativeId !== undefined && !ids.has(item.parentNativeId);
      const entity: NavigationEntity = {
        sourceId: this.sourceId,
        nativeId: item.nativeId,
        kind: item.relationship === 'subagent' ? 'subagent' : 'session',
        label: item.vendorTitle ?? item.firstMessagePreview ?? 'Untitled session · ' + shortId(item.nativeId),
        ...(item.vendorTitle === undefined ? {} : { vendorTitle: item.vendorTitle, titleSource: 'provider' as const }),
        ...(item.firstMessagePreview === undefined ? {} : { firstMessagePreview: item.firstMessagePreview }),
        ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
        ...(item.activityAt === undefined ? {} : { activityAt: item.activityAt, updatedAt: item.activityAt }),
        ...(item.parentNativeId !== undefined && !orphan ? { parentNativeId: item.parentNativeId } : {}),
        relationship: orphan ? 'orphan' : item.relationship,
        confidence: 'source',
        opaqueRef: 'claude-file-' + hash(item.relativePath),
      };
      entities.push(entity);
      locations.push({ nativeId: item.nativeId, relativePath: item.relativePath, rowOrdinal: '0' });
      if (item.parentNativeId !== undefined && !orphan) relations.push({ sourceId: this.sourceId, fromNativeId: item.nativeId, toNativeId: item.parentNativeId, kind: 'parent' });
    }
    const snapshot = this.snapshot(entities, relations, locations, new Date().toISOString(), truncated);
    return { snapshot, fingerprint: await this.probe(signal) };
  }
}

interface PendingClaudeSession {
  nativeId: string;
  relativePath: string;
  vendorTitle?: string;
  firstMessagePreview?: string;
  startedAt?: string;
  activityAt?: string;
  parentNativeId?: string;
  relationship: 'root' | 'subagent' | 'fork' | 'continuation';
}

function parseClaudeFile(text: string, relativePath: string, mtimeMs: number): PendingClaudeSession {
  const values: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/u).slice(0, 256)) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) values.push(value);
    } catch { /* Metadata scan is best effort; source remains available in the editor. */ }
  }
  const metadata = values.find((value) => firstString(value.sessionId, value.session_id) !== undefined || ['session', 'session_meta'].includes(String(value.type ?? '').toLowerCase()));
  const rawId = firstString(metadata?.sessionId, metadata?.session_id, metadata?.id) ?? basename(relativePath, extname(relativePath));
  const nativeId = safeId(rawId);
  const vendorTitle = cleanText(firstString(...values.flatMap((value) => [value.customTitle, value.sessionName, value.session_name, value.agentName, value.title, value.summary])));
  const firstMessagePreview = cleanText(firstString(...values.flatMap((value) => [value.preview, value.summary])));
  const timestamps = values.flatMap((value) => [value.timestamp, value.createdAt, value.created_at, value.updatedAt, value.updated_at]).filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
  const startedAt = normalizeTime(timestamps[0]);
  const activityAt = normalizeTime(timestamps.at(-1)) ?? new Date(mtimeMs).toISOString();
  const parentRaw = firstString(metadata?.parentSessionId, metadata?.parent_session_id);
  const relationship = /[\\/]subagents[\\/]/u.test(relativePath) ? 'subagent' : firstString(...values.flatMap((value) => [value.relationship, value.fork])) === 'continuation' ? 'continuation' : 'root';
  return { nativeId, relativePath, ...(vendorTitle === undefined ? {} : { vendorTitle }), ...(firstMessagePreview === undefined ? {} : { firstMessagePreview }), ...(startedAt === undefined ? {} : { startedAt }), ...(activityAt === undefined ? {} : { activityAt }), ...(parentRaw === undefined ? {} : { parentNativeId: safeId(parentRaw) }), relationship };
}

function readCodexSnapshot(db: DatabaseSync, rootPath: string, sourceId: string, budget: SessionNavigatorBudget, signal: AbortSignal, titles: ReadonlyMap<string, string>): NavigatorSnapshot {
  const columns = new Set(tableColumns(db, 'threads'));
  if (!columns.has('id') || !columns.has('rollout_path')) throw new Error('Codex state database has no compatible thread table.');
  const selected = ['id', 'rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'recency_at', 'recency_at_ms', 'title', 'name', 'preview', 'first_user_message', 'project_id', 'archived'].filter((name) => columns.has(name));
  const orderColumns = ['recency_at_ms', 'updated_at_ms', 'recency_at', 'updated_at', 'created_at_ms', 'created_at'].filter((name) => columns.has(name));
  const orderValue = orderColumns.length === 1 ? quoteIdentifier(orderColumns[0]!) : 'COALESCE(' + orderColumns.map(quoteIdentifier).join(', ') + ')';
  const order = orderColumns.length > 0 ? ' ORDER BY ' + orderValue + ' DESC, ' + quoteIdentifier('id') + ' ASC' : ' ORDER BY ' + quoteIdentifier('id') + ' ASC';
  const rows = db.prepare('SELECT ' + selected.map(quoteIdentifier).join(', ') + ' FROM threads' + order + ' LIMIT ?').all(Math.max(1, budget.maxEntities * 4)) as Array<Record<string, unknown>>;
  const candidates = rows.filter((row) => typeof row.id === 'string' && typeof row.rollout_path === 'string' && isAuthorizedPath(rootPath, String(row.rollout_path)));
  const edges = readCodexEdges(db, budget.maxRelations);
  const ids = new Set(candidates.map((row) => String(row.id)));
  const entities: NavigationEntity[] = [];
  const relations: NavigationRelation[] = [];
  const locations: NavigatorLocation[] = [];
  for (const row of candidates.slice(0, budget.maxEntities)) {
    throwIfAborted(signal);
    const id = String(row.id);
    const parent = edges.get(id);
    const orphan = parent !== undefined && !ids.has(parent);
    const vendorTitle = cleanText(asString(row.name) ?? asString(row.title) ?? titles.get(id));
    const firstMessagePreview = cleanText(asString(row.preview) ?? asString(row.first_user_message));
    const startedAt = normalizeTime(row.created_at_ms ?? row.created_at);
    const activityAt = normalizeTime(row.recency_at_ms ?? row.updated_at_ms ?? row.recency_at ?? row.updated_at) ?? startedAt;
    const project = asString(row.project_id);
    const entity: NavigationEntity = {
      sourceId, nativeId: id, kind: 'thread', label: vendorTitle ?? firstMessagePreview ?? 'Untitled session · ' + shortId(id),
      ...(vendorTitle === undefined ? {} : { vendorTitle, titleSource: 'provider' as const }),
      ...(firstMessagePreview === undefined ? {} : { firstMessagePreview }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(activityAt === undefined ? {} : { activityAt, updatedAt: activityAt }),
      ...(parent !== undefined && !orphan ? { parentNativeId: parent } : {}),
      relationship: orphan ? 'orphan' : parent === undefined ? 'root' : 'subagent',
      ...(project === undefined ? {} : { project }),
      ...(row.archived === 1 ? { status: 'archived' } : { status: 'available' }),
      confidence: 'source', opaqueRef: 'codex-thread-' + hash(id),
    };
    entities.push(entity);
    const rollout = String(row.rollout_path);
    locations.push({ nativeId: id, relativePath: relative(resolveRootPath(rootPath), resolve(stripLongPathPrefix(rollout))) || basename(rollout), rowOrdinal: '0' });
    if (parent !== undefined && !orphan) relations.push({ sourceId, fromNativeId: id, toNativeId: parent, kind: 'parent' });
  }
  return Object.freeze({
    schemaVersion: 1, provider: 'codex', sourceId, sourceGeneration: 'scan-codex', snapshotId: 'scan-' + sourceId + '-' + Date.now().toString(36),
    capturedAt: new Date().toISOString(), redaction: 'metadata-only', entities: Object.freeze(entities), relations: Object.freeze(relations), locations: Object.freeze(locations), truncated: candidates.length > budget.maxEntities,
    ...(candidates.length > budget.maxEntities ? { truncatedReason: 'entity_limit' as const } : {}),
  });
}

async function readCodexTitles(path: string, budget: SessionNavigatorBudget, signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
  if (!existsSync(path)) return new Map();
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || info.size > Math.min(2 * 1024 * 1024, budget.maxBytes)) return new Map();
  const result = new Map<string, string>();
  const text = new TextDecoder().decode(await readFile(path));
  let records = 0;
  for (const line of text.split(/\r?\n/u)) {
    throwIfAborted(signal);
    if (records++ >= budget.maxRecords) break;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) continue;
      const id = firstString(value.id, value.thread_id, value.threadId);
      const title = cleanText(firstString(value.thread_name, value.threadName, value.title, value.name));
      if (id !== undefined && title !== undefined) result.set(id, title);
    } catch { /* A malformed title entry does not invalidate the provider snapshot. */ }
  }
  return result;
}

function readCodexEdges(db: DatabaseSync, maxRelations: number): Map<string, string> {
  if (!tableExists(db, 'thread_spawn_edges')) return new Map();
  const rows = db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges ORDER BY child_thread_id ASC LIMIT ?').all(Math.max(1, maxRelations)) as Array<{ parent_thread_id?: unknown; child_thread_id?: unknown }>;
  return new Map(rows.filter((row) => typeof row.parent_thread_id === 'string' && typeof row.child_thread_id === 'string').map((row) => [String(row.child_thread_id), String(row.parent_thread_id)]));
}

async function findCodexStatePath(rootPath: string): Promise<string | undefined> {
  const info = await lstat(rootPath).catch(() => undefined);
  if (info?.isFile()) return /state(?:_\d+)?\.sqlite$/iu.test(basename(rootPath)) ? rootPath : undefined;
  if (!info?.isDirectory()) return undefined;
  const searchRoot = basename(rootPath).toLowerCase() === 'sessions' || basename(rootPath).toLowerCase() === 'archived_sessions' ? dirname(rootPath) : rootPath;
  const entries = await readdir(searchRoot).catch(() => []);
  const versioned = entries.filter((name) => /^state_\d+\.sqlite$/u.test(name)).sort((left, right) => Number(right.match(/\d+/u)?.[0] ?? 0) - Number(left.match(/\d+/u)?.[0] ?? 0));
  if (versioned[0] !== undefined) return join(searchRoot, versioned[0]);
  return existsSync(join(searchRoot, 'state.sqlite')) ? join(searchRoot, 'state.sqlite') : undefined;
}

async function openReadOnlyDatabase(path: string): Promise<DatabaseSync | undefined> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path, { readOnly: true, timeout: 3_000 });
  } catch { return undefined; }
}

function tableColumns(db: DatabaseSync, table: string): string[] { return (db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name?: string }>).flatMap((row) => typeof row.name === 'string' ? [row.name] : []); }
function tableExists(db: DatabaseSync, table: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined; }
function quoteIdentifier(value: string): string { return '"' + value.replaceAll('"', '""') + '"'; }
async function fileFingerprint(path: string): Promise<string> { const info = await stat(path); return path + '\0' + info.dev + '\0' + info.ino + '\0' + info.size + '\0' + info.mtimeMs; }

function isAuthorizedPath(rootPath: string, candidate: string): boolean {
  const root = canonicalPath(resolveRootPath(rootPath));
  const target = canonicalPath(stripLongPathPrefix(candidate));
  const suffix = relative(root, target);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..\\') && !suffix.startsWith('../'));
}

function canonicalPath(value: string): string {
  const resolved = resolve(value);
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

function resolveRootPath(rootPath: string): string {
  if (/state(?:_\d+)?\.sqlite$/iu.test(basename(rootPath))) return dirname(rootPath);
  try { return statSync(rootPath).isFile() ? dirname(rootPath) : rootPath; } catch { return rootPath; }
}

function resolveCodexHome(rootPath: string): string {
  const root = resolveRootPath(rootPath);
  return ['sessions', 'archived_sessions'].includes(basename(root).toLowerCase()) ? dirname(root) : root;
}

function stripLongPathPrefix(value: string): string {
  return value.length >= 4 && value.charCodeAt(0) === 92 && value.charCodeAt(1) === 92 && value[2] === '?' && value.charCodeAt(3) === 92
    ? value.slice(4)
    : value;
}
function normalizeTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) { const date = new Date(Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); }
  if (typeof value === 'string' && value.trim().length > 0) { const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); }
  return undefined;
}
function cleanText(value: string | undefined): string | undefined { if (value === undefined) return undefined; const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim(); return text.length === 0 ? undefined : text.slice(0, text.length > MAX_TITLE_LENGTH ? MAX_PREVIEW_LENGTH : MAX_TITLE_LENGTH); }
function firstString(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0); }
function asString(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length > 0 ? value : undefined; }
function safeId(value: string): string { return /^[A-Za-z0-9._:-]{1,256}$/u.test(value) ? value : 'id-' + hash(value); }
function shortId(value: string): string { return value.length > 12 ? value.slice(0, 12) : value; }
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 20); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error('Session navigator scan cancelled.'); }
