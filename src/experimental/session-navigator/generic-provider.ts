import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { NavigationEntity, NavigationEntityKind, NavigationRelation, NavigationRelationKind } from '../navigation-contract';
import { sourceIdFor } from './source-config';
import {
  DEFAULT_SESSION_NAVIGATOR_BUDGET,
  type AuthorizedSourceSetting,
  type NavigatorLocation,
  type NavigatorSnapshot,
  type SessionNavigatorBudget,
  type SessionNavigatorProvider,
  type SessionNavigatorProviderId,
  type SessionNavigatorScanResult,
} from './types';
import { collectFiles, type FileEntry } from './file-scan';

export { collectFiles, type FileEntry } from './file-scan';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LABEL_LENGTH = 160;
const MAX_STATUS_LENGTH = 64;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:\/\/)/u;

interface ParsedRecord {
  readonly entity: NavigationEntity;
  readonly location: NavigatorLocation;
  readonly relationInputs: readonly RelationInput[];
}

interface RelationInput {
  readonly from: string;
  readonly to: string;
  readonly kind: NavigationRelationKind;
}

export class FileSessionNavigatorProvider implements SessionNavigatorProvider {
  public readonly sourceId: string;
  public readonly provider: SessionNavigatorProviderId;
  public readonly rootUri: string;
  readonly #rootPath: string;

  public constructor(setting: AuthorizedSourceSetting, sourceId = sourceIdFor(setting)) {
    const parsed = new URL(setting.rootUri);
    if (parsed.protocol !== 'file:') throw new Error('Session navigator sources must use file URIs.');
    this.sourceId = sourceId;
    this.provider = setting.provider;
    this.rootUri = setting.rootUri;
    this.#rootPath = fileURLToPath(parsed);
  }

  public async probe(signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const files = await collectFiles(this.#rootPath, signal, { ...DEFAULT_SESSION_NAVIGATOR_BUDGET, maxFiles: 64 }, Date.now());
    throwIfAborted(signal);
    return fingerprint(files);
  }

  public async scan(signal: AbortSignal, budget: SessionNavigatorBudget): Promise<SessionNavigatorScanResult> {
    const started = Date.now();
    throwIfAborted(signal);
    const files = await collectFiles(this.#rootPath, signal, budget, started);
    const sourceGeneration = `scan-${fingerprint(files).slice(0, 24)}`;
    const capturedAt = new Date().toISOString();
    const records: ParsedRecord[] = [];
    const diagnostics: string[] = [];
    let bytesRead = 0;
    for (const file of files) {
      throwIfAborted(signal);
      if (Date.now() - started >= budget.maxMilliseconds) break;
      if (file.size > BigInt(MAX_FILE_BYTES) || bytesRead + Number(file.size) > budget.maxBytes) {
        diagnostics.push(`Skipped oversized source file: ${file.relativePath}`);
        continue;
      }
      const bytes = await readFile(file.path);
      bytesRead += bytes.byteLength;
      const text = new TextDecoder().decode(bytes);
      const lines = text.split(/\r?\n/u);
      for (let index = 0; index < lines.length && records.length < budget.maxRecords; index += 1) {
        throwIfAborted(signal);
        if (Date.now() - started >= budget.maxMilliseconds) break;
        const line = lines[index]?.trim();
        if (!line) continue;
        try {
          const value: unknown = JSON.parse(line);
          const parsed = parseRecord(value, this.provider, file.relativePath, String(index));
          if (parsed !== undefined) records.push(parsed);
        } catch {
          diagnostics.push(`Malformed record in ${file.relativePath}:${String(index)}`);
        }
      }
      if (records.length >= budget.maxRecords) break;
    }
    const entities = deduplicateEntities(records, budget.maxEntities).map((entity) => ({ ...entity, sourceId: this.sourceId }));
    const entityIds = new Set(entities.map((entity) => entity.nativeId));
    const relations = deduplicateRelations(records.flatMap((record) => record.relationInputs), entityIds, budget.maxRelations).map((relation) => ({ ...relation, sourceId: this.sourceId }));
    const locations = deduplicateLocations(records, new Set(entities.map((entity) => entity.nativeId)));
    const truncated = records.length >= budget.maxRecords || entities.length >= budget.maxEntities || relations.length >= budget.maxRelations || Date.now() - started >= budget.maxMilliseconds;
    const snapshot: NavigatorSnapshot = Object.freeze({
      schemaVersion: 1,
      provider: this.provider,
      snapshotId: `scan-${this.sourceId}-${sourceGeneration}`,
      sourceId: this.sourceId,
      sourceGeneration,
      capturedAt,
      redaction: 'metadata-only',
      entities: Object.freeze(entities.map((entity) => Object.freeze(entity))),
      relations: Object.freeze(relations.map((relation) => Object.freeze(relation))),
      locations: Object.freeze(locations.map((location) => Object.freeze(location))),
      truncated,
      ...(diagnostics.length > 0 ? { truncatedReason: 'record_limit' as const } : {}),
    });
    return { snapshot, fingerprint: fingerprint(files) };
  }

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
}

function parseRecord(value: unknown, provider: SessionNavigatorProviderId, relativePath: string, rowOrdinal: string): ParsedRecord | undefined {
  if (!isRecord(value)) return undefined;
  const type = firstString(value.type, value.event, value.kind) ?? 'event';
  const rawId = firstString(value.id, value.uuid, value.sessionId, value.leafUuid) ?? `${relativePath}:${rowOrdinal}`;
  const nativeId = normalizeId(rawId);
  const rawParent = firstString(value.parentId, value.parent_id, value.parentUuid, value.threadId);
  const parentNativeId = rawParent === undefined ? undefined : normalizeId(rawParent);
  const vendorTitle = safeOptionalLabel(firstString(value.title, value.summary, value.name));
  const firstMessagePreview = safeOptionalLabel(firstString(value.firstMessage, value.first_message));
  const startedAt = firstString(value.createdAt, value.created_at, value.timestamp);
  const updatedAt = firstString(value.updatedAt, value.updated_at, value.timestamp, value.createdAt);
  const label = vendorTitle ?? firstMessagePreview ?? safeLabel(undefined, `${type} ${nativeId.slice(0, 12)}`);
  const rawStatus = firstString(value.status, value.state);
  const entity: NavigationEntity = {
    sourceId: '',
    nativeId,
    kind: mapKind(type),
    label,
    ...(vendorTitle === undefined ? {} : { vendorTitle, titleSource: 'provider' as const }),
    ...(firstMessagePreview === undefined ? {} : { firstMessagePreview }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(updatedAt === undefined ? {} : { activityAt: updatedAt }),
    relationship: parentNativeId === undefined ? 'generic' : 'orphan',
    confidence: 'source',
    ...(parentNativeId === undefined ? {} : { parentNativeId }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(rawStatus === undefined ? {} : { status: safeStatus(rawStatus) }),
    opaqueRef: `loc-${createHash('sha256').update(`${relativePath}\0${rowOrdinal}`, 'utf8').digest('hex').slice(0, 20)}`,
  };
  const relations: RelationInput[] = [];
  if (parentNativeId !== undefined) relations.push({ from: nativeId, to: parentNativeId, kind: 'parent' });
  for (const relation of relationValues(value.relations)) {
    const target = firstString(relation.targetId, relation.to, relation.id);
    const kind = relationKind(relation.kind);
    if (target !== undefined && kind !== undefined) relations.push({ from: nativeId, to: normalizeId(target), kind });
  }
  return {
    entity: { ...entity, sourceId: '' },
    location: { nativeId, relativePath, rowOrdinal },
    relationInputs: relations,
  };
}

function deduplicateEntities(records: readonly ParsedRecord[], max: number): NavigationEntity[] {
  const seen = new Set<string>();
  const result: NavigationEntity[] = [];
  for (const record of records) {
    if (seen.has(record.entity.nativeId) || result.length >= max) continue;
    seen.add(record.entity.nativeId);
    result.push(record.entity);
  }
  return result;
}

function deduplicateRelations(inputs: readonly RelationInput[], entities: ReadonlySet<string>, max: number): NavigationRelation[] {
  const seen = new Set<string>();
  const result: NavigationRelation[] = [];
  for (const relation of inputs) {
    if (!entities.has(relation.from) || !entities.has(relation.to)) continue;
    const key = `${relation.from}\0${relation.to}\0${relation.kind}`;
    if (seen.has(key) || result.length >= max) continue;
    seen.add(key);
    result.push({ sourceId: '', fromNativeId: relation.from, toNativeId: relation.to, kind: relation.kind });
  }
  return result;
}

function deduplicateLocations(records: readonly ParsedRecord[], entities: ReadonlySet<string>): NavigatorLocation[] {
  const seen = new Set<string>();
  const result: NavigatorLocation[] = [];
  for (const record of records) {
    if (!entities.has(record.location.nativeId) || seen.has(record.location.nativeId)) continue;
    seen.add(record.location.nativeId);
    result.push(record.location);
  }
  return result;
}

function fingerprint(files: readonly FileEntry[]): string {
  return createHash('sha256').update(files.map((file) => `${file.relativePath}\0${file.size.toString()}\0${String(file.mtimeMs)}`).join('\n'), 'utf8').digest('hex');
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function mapKind(type: string): NavigationEntityKind {
  const normalized = type.toLowerCase();
  if (normalized.includes('session')) return 'session';
  if (normalized.includes('thread')) return 'thread';
  if (normalized.includes('fork')) return 'other';
  if (normalized.includes('subagent') || normalized.includes('agent')) return 'subagent';
  if (normalized.includes('workflow')) return 'workflow';
  if (normalized.includes('team')) return 'team';
  if (normalized.includes('tool') || normalized.includes('call')) return 'tool';
  if (normalized.includes('goal')) return 'goal';
  if (normalized.includes('plan')) return 'plan';
  if (normalized.includes('memory')) return 'memory';
  if (normalized.includes('task')) return 'task';
  if (normalized.includes('event') || normalized.includes('message') || normalized.includes('response')) return 'event';
  return 'other';
}

function relationKind(value: unknown): NavigationRelationKind | undefined {
  if (value === 'parent' || value === 'child' || value === 'fork' || value === 'spawn' || value === 'contains' || value === 'uses') return value;
  return undefined;
}

function relationValues(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord).slice(0, 32) : [];
}

function normalizeId(value: string): string {
  if (SAFE_ID.test(value)) return value;
  return `id-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

function safeLabel(value: string | undefined, fallback: string): string {
  const candidate = value && !CONTROL.test(value) && !PATH_LIKE.test(value) ? value.trim() : fallback;
  return candidate.slice(0, MAX_LABEL_LENGTH) || fallback;
}

function safeOptionalLabel(value: string | undefined): string | undefined {
  if (value === undefined || CONTROL.test(value) || PATH_LIKE.test(value)) return undefined;
  const trimmed = value.trim().slice(0, MAX_LABEL_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeStatus(value: string): string {
  return CONTROL.test(value) ? 'unknown' : value.slice(0, MAX_STATUS_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Session navigator scan cancelled.');
}
