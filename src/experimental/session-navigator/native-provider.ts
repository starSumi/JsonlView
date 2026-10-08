import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { NavigationEntity, NavigationRelation } from '../navigation-contract';
import { collectFiles, FileSessionNavigatorProvider } from './file-provider';
import { sourceIdFor } from './source-config';
import { claudeFingerprint, collectClaudeFiles, readClaudeMetadata, type ClaudeMetadata } from './claude-metadata';
import { MetadataBudget, readMetadataRecords, userMessagePreview } from './provider-metadata';
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
    const metadataBudget = new MetadataBudget(budget, signal);
    const fingerprint = await this.probe(signal);
    const statePath = await findCodexStatePath(this.stateRootPath);
    if (statePath === undefined) throw new Error('Codex state database was not found under the provider home.');
    const db = await openReadOnlyDatabase(statePath);
    if (db === undefined) throw new Error('Codex state database could not be opened read-only.');
    try {
      const titles = await readCodexTitles(join(resolveCodexHome(this.rootPath), 'session_index.jsonl'), metadataBudget);
      db.exec('BEGIN');
      let snapshot: NavigatorSnapshot;
      try {
        snapshot = readCodexSnapshot(db, this.rootPath, this.sourceId, budget, signal, titles);
      } finally {
        db.exec('ROLLBACK');
      }
      snapshot = await fillCodexPreviews(snapshot, this.rootPath, metadataBudget);
      // The transaction is coherent even while Codex writes its WAL. This earlier
      // advisory fingerprint lets the next probe flag updates without starving scans.
      return { snapshot, fingerprint };
    } finally {
      db.close();
    }
  }
}

class ClaudeSessionNavigatorProvider extends NativeSessionNavigatorProvider {
  public async probe(signal: AbortSignal): Promise<string> {
    const { files } = await collectClaudeFiles(this.rootPath, new MetadataBudget(DEFAULT_SESSION_NAVIGATOR_BUDGET, signal));
    return claudeFingerprint(files);
  }

  public async scan(signal: AbortSignal, budget: SessionNavigatorBudget): Promise<SessionNavigatorScanResult> {
    const metadataBudget = new MetadataBudget(budget, signal);
    const collected = await collectClaudeFiles(this.rootPath, metadataBudget);
    const files = collected.files;
    const pending = new Map<string, ClaudeMetadata>();
    let truncated = collected.truncated;
    for (const file of files) {
      throwIfAborted(signal);
      if (!metadataBudget.available() || pending.size >= budget.maxEntities) { truncated = true; break; }
      try {
        const result = await readClaudeMetadata(file, metadataBudget);
        truncated ||= result.sampled;
        if (result.metadata !== undefined && !pending.has(result.metadata.nativeId)) pending.set(result.metadata.nativeId, result.metadata);
      } catch (error) {
        throwIfAborted(signal);
        if (isRecord(error) && ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))) { truncated = true; continue; }
        throw error;
      }
    }
    const ids = new Set(pending.keys());
    const entities: NavigationEntity[] = [];
    const relations: NavigationRelation[] = [];
    const locations: NavigatorLocation[] = [];
    for (const item of pending.values()) {
      const orphan = item.parentNativeId !== undefined && !ids.has(item.parentNativeId);
      const parent = item.parentNativeId !== undefined && !orphan && relations.length < budget.maxRelations ? item.parentNativeId : undefined;
      if (item.parentNativeId !== undefined && !orphan && parent === undefined) truncated = true;
      const entity: NavigationEntity = {
        sourceId: this.sourceId,
        nativeId: item.nativeId,
        kind: item.relationship === 'subagent' ? 'subagent' : 'session',
        label: item.vendorTitle ?? item.firstMessagePreview ?? 'Untitled session · ' + shortId(item.nativeId),
        ...(item.vendorTitle === undefined ? {} : { vendorTitle: item.vendorTitle, titleSource: 'provider' as const }),
        ...(item.firstMessagePreview === undefined ? {} : { firstMessagePreview: item.firstMessagePreview }),
        ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
        ...(item.activityAt === undefined ? {} : { activityAt: item.activityAt, updatedAt: item.activityAt }),
        ...(parent === undefined ? {} : { parentNativeId: parent }),
        relationship: orphan || (item.parentNativeId !== undefined && parent === undefined) ? 'orphan' : item.relationship,
        confidence: 'source',
        opaqueRef: 'claude-file-' + hash(item.relativePath),
      };
      entities.push(entity);
      locations.push({ nativeId: item.nativeId, relativePath: item.relativePath, rowOrdinal: '0' });
      if (parent !== undefined) relations.push({ sourceId: this.sourceId, fromNativeId: item.nativeId, toNativeId: parent, kind: 'parent' });
    }
    const snapshot = this.snapshot(entities, relations, locations, new Date().toISOString(), truncated || metadataBudget.truncated);
    return { snapshot, fingerprint: claudeFingerprint(files) };
  }
}

function readCodexSnapshot(db: DatabaseSync, rootPath: string, sourceId: string, budget: SessionNavigatorBudget, signal: AbortSignal, titles: ReadonlyMap<string, string>): NavigatorSnapshot {
  const columns = new Set(tableColumns(db, 'threads'));
  if (!columns.has('id') || !columns.has('rollout_path')) throw new Error('Codex state database has no compatible thread table.');
  const selected = ['id', 'rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'recency_at', 'recency_at_ms', 'title', 'name', 'agent_nickname', 'agent_role', 'preview', 'first_user_message', 'project_id', 'archived'].filter((name) => columns.has(name));
  const orderColumns = ['recency_at_ms', 'updated_at_ms', 'recency_at', 'updated_at', 'created_at_ms', 'created_at'].filter((name) => columns.has(name));
  const orderValue = orderColumns.length === 1 ? quoteIdentifier(orderColumns[0]!) : 'COALESCE(' + orderColumns.map(quoteIdentifier).join(', ') + ')';
  const order = orderColumns.length > 0 ? ' ORDER BY ' + orderValue + ' DESC, ' + quoteIdentifier('id') + ' ASC' : ' ORDER BY ' + quoteIdentifier('id') + ' ASC';
  const boundedText = new Set(['title', 'name', 'agent_nickname', 'agent_role', 'preview', 'first_user_message']);
  const projection = selected.map((name) => boundedText.has(name) ? 'substr(' + quoteIdentifier(name) + ', 1, 240) AS ' + quoteIdentifier(name) : quoteIdentifier(name));
  const rowLimit = Math.max(0, Math.min(budget.maxRecords, budget.maxEntities * 4));
  const rows = db.prepare('SELECT ' + projection.join(', ') + ' FROM threads' + order + ' LIMIT ?').all(rowLimit) as Array<Record<string, unknown>>;
  const canonicalRoot = canonicalPath(resolveRootPath(rootPath));
  const candidates = rows.flatMap((row) => {
    if (typeof row.id !== 'string' || typeof row.rollout_path !== 'string') return [];
    const relativePath = authorizedRelativePath(canonicalRoot, row.rollout_path);
    return relativePath === undefined ? [] : [{ row, relativePath }];
  });
  const ids = new Set(candidates.slice(0, budget.maxEntities).map(({ row }) => String(row.id)));
  const edges = readCodexEdges(db, [...ids]);
  const entities: NavigationEntity[] = [];
  const relations: NavigationRelation[] = [];
  const locations: NavigatorLocation[] = [];
  let relationsTruncated = false;
  for (const { row, relativePath } of candidates.slice(0, budget.maxEntities)) {
    throwIfAborted(signal);
    const id = String(row.id);
    const parent = edges.get(id);
    const relationLimited = parent !== undefined && ids.has(parent) && relations.length >= budget.maxRelations;
    relationsTruncated ||= relationLimited;
    const orphan = parent !== undefined && (!ids.has(parent) || relationLimited);
    const agentTitle = [cleanText(asString(row.agent_nickname)), cleanText(asString(row.agent_role))].filter((part) => part !== undefined).join(' · ');
    const vendorTitle = cleanText(asString(row.name) ?? titles.get(id) ?? asString(agentTitle) ?? asString(row.title));
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
    locations.push({ nativeId: id, relativePath, rowOrdinal: '0' });
    if (parent !== undefined && !orphan) relations.push({ sourceId, fromNativeId: id, toNativeId: parent, kind: 'parent' });
  }
  return Object.freeze({
    schemaVersion: 1, provider: 'codex', sourceId, sourceGeneration: 'scan-codex', snapshotId: 'scan-' + sourceId + '-' + Date.now().toString(36),
    capturedAt: new Date().toISOString(), redaction: 'metadata-only', entities: Object.freeze(entities), relations: Object.freeze(relations), locations: Object.freeze(locations), truncated: candidates.length > budget.maxEntities || rows.length >= rowLimit || relationsTruncated,
    ...(candidates.length > budget.maxEntities ? { truncatedReason: 'entity_limit' as const } : relationsTruncated ? { truncatedReason: 'relation_limit' as const } : rows.length >= rowLimit ? { truncatedReason: 'record_limit' as const } : {}),
  });
}

async function readCodexTitles(path: string, budget: MetadataBudget): Promise<ReadonlyMap<string, string>> {
  if (!existsSync(path)) return new Map();
  const result = new Map<string, string>();
  for (const value of (await readMetadataRecords(path, budget, 0, 256 * 1024)).values) {
    const id = firstString(value.id, value.thread_id, value.threadId);
    const title = cleanText(firstString(value.thread_name, value.threadName, value.title, value.name));
    if (id !== undefined && title !== undefined) result.set(id, title);
  }
  return result;
}

async function fillCodexPreviews(snapshot: NavigatorSnapshot, rootPath: string, budget: MetadataBudget): Promise<NavigatorSnapshot> {
  const locations = new Map(snapshot.locations.map((location) => [location.nativeId, location]));
  const entities: NavigationEntity[] = [];
  let files = 0;
  for (const entity of snapshot.entities) {
    if (entity.vendorTitle !== undefined || entity.firstMessagePreview !== undefined) { entities.push(entity); continue; }
    const location = locations.get(entity.nativeId);
    if (location === undefined || files >= budget.limits.maxFiles || !budget.available()) { entities.push(entity); continue; }
    files += 1;
    try {
      const path = join(resolveRootPath(rootPath), location.relativePath);
      if (authorizedRelativePath(canonicalPath(resolveRootPath(rootPath)), path) === undefined) { entities.push(entity); continue; }
      const records = await readMetadataRecords(path, budget);
      const preview = records.values.map(userMessagePreview).find((value) => value !== undefined);
      entities.push(preview === undefined ? entity : { ...entity, label: preview, firstMessagePreview: preview });
    } catch { throwIfAborted(budget.signal); entities.push(entity); }
  }
  return Object.freeze({ ...snapshot, entities: Object.freeze(entities), truncated: snapshot.truncated || budget.truncated, ...(budget.truncated ? { truncatedReason: 'record_limit' as const } : {}) });
}

function readCodexEdges(db: DatabaseSync, childIds: readonly string[]): Map<string, string> {
  if (childIds.length === 0 || !tableExists(db, 'thread_spawn_edges')) return new Map();
  // Inspect the selected children's edges before capping emitted relations. A
  // global edge limit would silently relabel a selected child as a root.
  const rows = db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges WHERE child_thread_id IN (' + childIds.map(() => '?').join(', ') + ') LIMIT ?').all(...childIds, childIds.length) as Array<{ parent_thread_id?: unknown; child_thread_id?: unknown }>;
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

function authorizedRelativePath(canonicalRoot: string, candidate: string): string | undefined {
  const target = canonicalPath(stripLongPathPrefix(candidate));
  const suffix = relative(canonicalRoot, target);
  return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..\\') && !suffix.startsWith('../')
    ? suffix
    : undefined;
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
function shortId(value: string): string { return value.length > 12 ? value.slice(0, 12) : value; }
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 20); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error('Session navigator scan cancelled.'); }
