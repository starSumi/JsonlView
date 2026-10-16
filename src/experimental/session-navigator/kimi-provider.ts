import { createHash } from 'node:crypto';
import { lstat, open, opendir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NavigationBudget, NavigationEntity, NavigationRelation } from '../navigation-contract';
import { isMetadataRecord, MetadataBudget, metadataText } from './provider-metadata';
import { sourceIdFor } from './source-config';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET, type AuthorizedSourceSetting, type NavigatorLocation, type NavigatorSnapshot, type SessionNavigatorBudget, type SessionNavigatorProvider, type SessionNavigatorScanResult } from './types';

const MAX_INVENTORY = 4_096;
const MAX_DIRECTORY_ENTRIES = 16_384;
const MAX_STATE_BYTES = 64 * 1_024;
interface SessionEntry { sessionKey: string; agentId: string; relativePath: string; statePath?: string; signature: string }
interface Inventory { entries: SessionEntry[]; fingerprint: string; partial: boolean }
interface Discovery { entries: number; partial: boolean; budget: MetadataBudget }

/** Only the authorized home/sessions layout is traversed; wire bodies and index paths stay unread. */
export class KimiSessionNavigatorProvider implements SessionNavigatorProvider {
  public readonly provider = 'kimi' as const;
  public readonly sourceId: string;
  public readonly rootUri: string;
  private readonly rootPath: string;

  public constructor(setting: AuthorizedSourceSetting) {
    const root = new URL(setting.rootUri);
    if (root.protocol !== 'file:') throw new Error('Session navigator sources must use file URIs.');
    this.rootUri = setting.rootUri;
    this.rootPath = fileURLToPath(root);
    this.sourceId = sourceIdFor(setting);
  }

  public async probe(signal: AbortSignal): Promise<string> {
    return (await this.inventory(new MetadataBudget(DEFAULT_SESSION_NAVIGATOR_BUDGET, signal))).fingerprint;
  }

  public async scan(signal: AbortSignal, budget: SessionNavigatorBudget): Promise<SessionNavigatorScanResult> {
    return this.scanPage(signal, budget);
  }

  public async readSnapshot(signal: AbortSignal, budget: Required<NavigationBudget>): Promise<NavigatorSnapshot> {
    return (await this.scan(signal, { ...DEFAULT_SESSION_NAVIGATOR_BUDGET, ...budget })).snapshot;
  }

  public async scanPage(signal: AbortSignal, limits: SessionNavigatorBudget, cursor?: string): Promise<SessionNavigatorScanResult> {
    const started = Date.now();
    const budget = new MetadataBudget(limits, signal);
    const inventory = await this.inventory(budget);
    const offset = decodeCursor(cursor, inventory.fingerprint);
    if (offset > inventory.entries.length) throw new Error('Kimi navigator continuation is out of range.');
    const entities: NavigationEntity[] = [];
    const relations: NavigationRelation[] = [];
    const locations: NavigatorLocation[] = [];
    const states = new Map<string, Record<string, unknown>>();
    let consumed = 0;
    let partial = inventory.partial;
    for (const entry of inventory.entries.slice(offset, offset + Math.max(0, Math.min(limits.maxFiles, limits.maxEntities)))) {
      if (!budget.check()) break;
      let state = states.get(entry.sessionKey);
      if (state === undefined) {
        if (!budget.available()) break;
        const result = await readState(entry.statePath, budget);
        state = result.state;
        states.set(entry.sessionKey, state);
        partial ||= result.partial;
      }
      if (!budget.check()) break;
      const entity = this.entity(entry, state);
      if (entity.parentNativeId !== undefined) {
        if (relations.length < limits.maxRelations) relations.push({ sourceId: this.sourceId, fromNativeId: entity.parentNativeId, toNativeId: entity.nativeId, kind: 'parent' });
        else { delete entity.parentNativeId; entity.relationship = 'orphan'; partial = true; }
      }
      entities.push(entity);
      locations.push({ nativeId: entity.nativeId, relativePath: entry.relativePath, rowOrdinal: '0' });
      consumed += 1;
    }
    budget.check();
    const hasMore = offset + consumed < inventory.entries.length;
    const nextCursor = hasMore && consumed > 0 && !inventory.partial ? 'kimi-v1:' + inventory.fingerprint + ':' + String(offset + consumed) : undefined;
    const capturedAt = new Date().toISOString();
    const generation = 'scan-' + digest(this.sourceId + '\0' + inventory.fingerprint + '\0' + String(offset) + '\0' + capturedAt);
    const truncated = partial || budget.truncated || hasMore;
    const snapshot: NavigatorSnapshot = Object.freeze({
      schemaVersion: 1, provider: this.provider, sourceId: this.sourceId, snapshotId: generation, sourceGeneration: generation, capturedAt, redaction: 'metadata-only',
      entities: Object.freeze(entities.map((entity) => Object.freeze(entity))), relations: Object.freeze(relations.map((relation) => Object.freeze(relation))), locations: Object.freeze(locations.map((location) => Object.freeze(location))), truncated,
      ...(truncated ? { truncatedReason: Date.now() - started >= limits.maxMilliseconds ? 'time_limit' as const : 'record_limit' as const } : {}),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
    return { snapshot, fingerprint: inventory.fingerprint, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  private entity(entry: SessionEntry, state: Record<string, unknown>): NavigationEntity {
    const main = entry.agentId === 'main';
    const agentValue = isMetadataRecord(state.agents) && Object.hasOwn(state.agents, entry.agentId) ? state.agents[entry.agentId] : undefined;
    const agent = isMetadataRecord(agentValue) ? agentValue : {};
    const parent = safeAgentId(agent.parentAgentId);
    const parentNativeId = !main && parent !== undefined && parent !== entry.agentId ? nativeId(entry.sessionKey, parent) : undefined;
    const title = main ? boundedText(state.title ?? state.customTitle, 160) : undefined;
    const preview = main ? boundedText(state.lastPrompt, 240) : undefined;
    const startedAt = timestamp(state.createdAt);
    const activityAt = timestamp(state.updatedAt);
    const status = typeof state.lastTurnReason === 'string' && ['completed', 'cancelled', 'failed'].includes(state.lastTurnReason) ? state.lastTurnReason : undefined;
    return {
      sourceId: this.sourceId, nativeId: nativeId(entry.sessionKey, entry.agentId), kind: main ? 'session' : 'subagent',
      label: title ?? preview ?? (main ? 'Kimi session ' + digest(entry.sessionKey).slice(0, 12) : 'Kimi agent ' + entry.agentId),
      titleSource: title !== undefined ? 'provider' : preview !== undefined ? 'first-message' : 'id',
      ...(title === undefined ? {} : { vendorTitle: title }), ...(preview === undefined ? {} : { firstMessagePreview: preview }),
      ...(startedAt === undefined ? {} : { startedAt }), ...(activityAt === undefined ? {} : { activityAt, updatedAt: activityAt }),
      ...(status === undefined ? {} : { status }),
      ...(parentNativeId === undefined ? {} : { parentNativeId }),
      relationship: main ? 'root' : parentNativeId === undefined ? 'orphan' : 'subagent', confidence: 'source',
    };
  }

  private async inventory(budget: MetadataBudget): Promise<Inventory> {
    budget.check();
    if (!(await regularDirectory(this.rootPath))) throw new Error('Kimi navigator home must be a regular directory.');
    const discovery: Discovery = { entries: 0, partial: false, budget };
    const entries: SessionEntry[] = [];
    const sessions = join(this.rootPath, 'sessions');
    for (const workspace of await directories(sessions, discovery)) {
      for (const session of await directories(workspace, discovery)) {
        if (!budget.check() || entries.length >= MAX_INVENTORY) { discovery.partial = true; break; }
        const statePath = await stateFile(session);
        const state = statePath === undefined ? undefined : await regularFile(statePath);
        const sessionKey = relative(sessions, session).replaceAll('\\', '/');
        for (const agentPath of await directories(join(session, 'agents'), discovery)) {
          if (!budget.check() || entries.length >= MAX_INVENTORY) { discovery.partial = true; break; }
          const agentId = safeAgentId(relative(join(session, 'agents'), agentPath));
          if (agentId === undefined) { discovery.partial = true; continue; }
          const wirePath = join(agentPath, 'wire.jsonl');
          const wire = await regularFile(wirePath);
          if (wire === undefined) continue;
          const relativePath = relative(this.rootPath, wirePath).replaceAll('\\', '/');
          entries.push({ sessionKey, agentId, relativePath, ...(statePath === undefined ? {} : { statePath }),
            signature: relativePath + '\0' + String(wire.size) + '\0' + String(wire.mtimeMs) + '\0' + (statePath === undefined ? '' : relative(this.rootPath, statePath)) + '\0' + String(state?.size) + '\0' + String(state?.mtimeMs) });
        }
      }
    }
    entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
    return { entries, partial: discovery.partial || budget.truncated, fingerprint: digest(this.sourceId + '\n' + entries.map((entry) => entry.signature).join('\n')) };
  }
}

async function directories(path: string, discovery: Discovery): Promise<string[]> {
  if (!discovery.budget.check() || discovery.entries >= MAX_DIRECTORY_ENTRIES) { discovery.partial = true; return []; }
  if (!(await regularDirectory(path))) return [];
  const paths: string[] = [];
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (!discovery.budget.check() || ++discovery.entries > MAX_DIRECTORY_ENTRIES) { discovery.partial = true; break; }
      if (entry.isDirectory() && !entry.isSymbolicLink()) paths.push(join(path, entry.name));
    }
  } catch { discovery.budget.check(); discovery.partial = true; }
  return paths.sort();
}

async function regularDirectory(path: string): Promise<boolean> {
  const value = await lstat(path).catch(() => undefined);
  return value?.isDirectory() === true && !value.isSymbolicLink();
}
async function regularFile(path: string) {
  const value = await lstat(path).catch(() => undefined);
  return value?.isFile() === true && !value.isSymbolicLink() ? value : undefined;
}
async function stateFile(session: string): Promise<string | undefined> {
  const direct = join(session, 'state.json');
  if (await regularFile(direct)) return direct;
  const legacy = join(session, 'session-meta');
  if (!(await regularDirectory(legacy))) return undefined;
  const path = join(legacy, 'state.json');
  return await regularFile(path) ? path : undefined;
}

async function readState(path: string | undefined, budget: MetadataBudget): Promise<{ state: Record<string, unknown>; partial: boolean }> {
  if (path === undefined) return { state: {}, partial: true };
  budget.records += 1;
  const before = await regularFile(path);
  if (before === undefined || before.size > MAX_STATE_BYTES || before.size > budget.limits.maxBytes - budget.bytes) return { state: {}, partial: true };
  const file = await open(path, 'r').catch(() => undefined);
  if (file === undefined) return { state: {}, partial: true };
  try {
    const stat = await file.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) return { state: {}, partial: true };
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    budget.bytes += bytesRead;
    if (bytesRead !== stat.size || !budget.check()) return { state: {}, partial: true };
    const after = await file.stat();
    const current = await regularFile(path);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current?.ino !== stat.ino || current?.dev !== stat.dev) return { state: {}, partial: true };
    try {
      const state: unknown = JSON.parse(buffer.toString('utf8'));
      return isMetadataRecord(state) ? { state, partial: false } : { state: {}, partial: true };
    } catch { return { state: {}, partial: true }; }
  } finally { await file.close(); }
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function nativeId(sessionKey: string, agentId: string): string { return 'kimi:' + digest(sessionKey) + ':' + agentId; }
function safeAgentId(value: unknown): string | undefined { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value) ? value : undefined; }
function boundedText(value: unknown, limit: number): string | undefined { return typeof value === 'string' ? metadataText(value.slice(0, limit * 4), limit) : undefined; }
function timestamp(value: unknown): string | undefined {
  const milliseconds = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 64 ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : undefined;
}
function decodeCursor(cursor: string | undefined, fingerprint: string): number {
  if (cursor === undefined) return 0;
  const match = /^kimi-v1:([a-f0-9]{64}):(0|[1-9][0-9]{0,5})$/u.exec(cursor);
  if (match === null || match[1] !== fingerprint) throw new Error('Kimi navigator continuation is invalid or stale.');
  return Number(match[2]);
}
