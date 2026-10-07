import { createHash } from 'node:crypto';

import type {
  NavigationBudget,
  NavigationEntity,
  NavigationEntityKind,
  NavigationProvider,
  NavigationRelation,
  NavigationRelationKind,
  NavigationSnapshot,
} from './navigation-contract';

/** Version of the synthetic adapter input and index projection. */
export const SYNTHETIC_NAVIGATION_SCHEMA_VERSION = 1 as const;

export type SyntheticNodeKind = Exclude<NavigationEntityKind, 'source' | 'other'>;
export type SyntheticEdgeKind = NavigationRelationKind;

export interface SyntheticRelationInput {
  readonly kind: string;
  readonly targetId: string;
}

/**
 * Deliberately small, producer-neutral input. Unknown properties are ignored;
 * they must never become part of the metadata projection.
 */
export interface SyntheticNavigationRecord {
  readonly type: string;
  readonly id: string;
  readonly label?: string;
  readonly parentId?: string;
  readonly relations?: readonly SyntheticRelationInput[];
  readonly updatedAt?: string;
  readonly status?: string;
  readonly confidence?: NavigationEntity['confidence'];
}

export interface SyntheticNavigationInput {
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly capturedAt: string;
  readonly records: readonly unknown[];
}

export interface SyntheticNavigationBudget {
  readonly maxEntities?: number;
  readonly maxRelations?: number;
}

export type SyntheticDiagnosticCode = 'malformed' | 'unsupported';

export interface SyntheticDiagnostic {
  readonly index: number;
  readonly code: SyntheticDiagnosticCode;
  readonly reason:
    | 'record_not_object'
    | 'missing_id'
    | 'invalid_id'
    | 'unsupported_type'
    | 'invalid_label'
    | 'invalid_parent'
    | 'invalid_relation'
    | 'duplicate_id'
    | 'invalid_timestamp'
    | 'invalid_status'
    | 'invalid_confidence';
}

export interface SyntheticNavigationIndex {
  readonly schemaVersion: typeof SYNTHETIC_NAVIGATION_SCHEMA_VERSION;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly snapshot: NavigationSnapshot;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly diagnostics: readonly SyntheticDiagnostic[];
}

export interface SyntheticNavigationBuildOptions extends SyntheticNavigationBudget {
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly capturedAt: string;
  readonly records: readonly unknown[];
}

export type SyntheticBuildStatus = 'ok' | 'malformed' | 'unsupported';

export interface SyntheticNavigationBuildResult {
  readonly status: SyntheticBuildStatus;
  readonly index: SyntheticNavigationIndex;
}

const DEFAULT_MAX_ENTITIES = 500;
const DEFAULT_MAX_RELATIONS = 2_000;
const MAX_ENTITIES = 10_000;
const MAX_RELATIONS = 50_000;
const MAX_RECORD_RELATIONS = 32;
const MAX_LABEL_LENGTH = 256;
const MAX_STATUS_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:\/\/)/u;

const SUPPORTED_TYPES = new Set<SyntheticNodeKind>([
  'session',
  'thread',
  'turn',
  'workflow',
  'team',
  'tool',
  'goal',
  'plan',
  'memory',
  'task',
  'subagent',
  'event',
]);
const SUPPORTED_RELATIONS = new Set<SyntheticEdgeKind>(['parent', 'child', 'fork', 'spawn', 'contains', 'uses']);

/**
 * Build an immutable, metadata-only index from synthetic records. This is a
 * test seam for future producer adapters, not a reader for any local store.
 */
export function buildSyntheticNavigationIndex(options: SyntheticNavigationBuildOptions): SyntheticNavigationBuildResult {
  const maxEntities = normalizeBudget(options.maxEntities, DEFAULT_MAX_ENTITIES, MAX_ENTITIES, 'maxEntities');
  const maxRelations = normalizeBudget(options.maxRelations, DEFAULT_MAX_RELATIONS, MAX_RELATIONS, 'maxRelations');
  assertOpaque(options.sourceId, 'sourceId');
  assertOpaque(options.sourceGeneration, 'sourceGeneration');
  assertTimestamp(options.capturedAt, 'capturedAt');

  const diagnostics: SyntheticDiagnostic[] = [];
  const entities: NavigationEntity[] = [];
  const parsedRelations: Array<{ readonly from: string; readonly to: string; readonly kind: SyntheticEdgeKind }> = [];
  const ids = new Set<string>();

  for (const [index, raw] of options.records.entries()) {
    const parsed = parseRecord(raw, index, options.sourceId, diagnostics);
    if (parsed === undefined) continue;
    if (ids.has(parsed.entity.nativeId)) {
      diagnostics.push({ index, code: 'malformed', reason: 'duplicate_id' });
      continue;
    }
    ids.add(parsed.entity.nativeId);
    entities.push(parsed.entity);
    if (parsed.parentId !== undefined) {
      parsedRelations.push({ from: parsed.parentId, to: parsed.entity.nativeId, kind: 'parent' });
    }
    parsedRelations.push(...parsed.relations);
  }

  const truncatedByEntities = entities.length > maxEntities;
  const boundedEntities = entities.slice(0, maxEntities);
  const visibleIds = new Set(boundedEntities.map((entity) => entity.nativeId));
  const relations: NavigationRelation[] = [];
  const relationKeys = new Set<string>();
  let truncatedByRelations = false;
  for (const relation of parsedRelations) {
    if (!visibleIds.has(relation.from) || !visibleIds.has(relation.to)) continue;
    const key = relation.from + '\u0000' + relation.to + '\u0000' + relation.kind;
    if (relationKeys.has(key)) continue;
    relationKeys.add(key);
    if (relations.length >= maxRelations) {
      truncatedByRelations = true;
      break;
    }
    relations.push({
      sourceId: options.sourceId,
      fromNativeId: relation.from,
      toNativeId: relation.to,
      kind: relation.kind,
    });
  }

  const truncated = truncatedByEntities || truncatedByRelations;
  const truncatedReason = truncatedByEntities ? 'entity_limit' : truncatedByRelations ? 'relation_limit' : undefined;
  const snapshotId = createSnapshotId(options.sourceId, options.sourceGeneration, boundedEntities, relations, maxEntities, maxRelations);
  const snapshot: NavigationSnapshot = Object.freeze({
    snapshotId,
    sourceId: options.sourceId,
    sourceGeneration: options.sourceGeneration,
    capturedAt: options.capturedAt,
    redaction: 'metadata-only',
    entities: Object.freeze(boundedEntities.map((entity) => Object.freeze(entity))),
    relations: Object.freeze(relations.map((relation) => Object.freeze(relation))),
    truncated,
    ...(truncatedReason === undefined ? {} : { truncatedReason }),
  });
  const index: SyntheticNavigationIndex = Object.freeze({
    schemaVersion: SYNTHETIC_NAVIGATION_SCHEMA_VERSION,
    sourceId: options.sourceId,
    sourceGeneration: options.sourceGeneration,
    snapshot,
    acceptedRecords: entities.length,
    rejectedRecords: diagnostics.length,
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
  });
  const hasMalformed = diagnostics.some((diagnostic) => diagnostic.code === 'malformed');
  const hasUnsupported = diagnostics.some((diagnostic) => diagnostic.code === 'unsupported');
  const status: SyntheticBuildStatus = entities.length > 0 || diagnostics.length === 0
    ? 'ok'
    : hasMalformed
      ? 'malformed'
      : hasUnsupported
        ? 'unsupported'
        : 'ok';
  return { status, index };
}

/** Pure adapter façade; it owns no source handle and never performs I/O. */
export class SyntheticNavigationAdapter {
  public constructor(public readonly sourceId: string) {
    assertOpaque(sourceId, 'sourceId');
  }

  public build(
    input: Omit<SyntheticNavigationBuildOptions, 'sourceId'>,
    budget?: SyntheticNavigationBudget,
  ): SyntheticNavigationBuildResult {
    return buildSyntheticNavigationIndex({ ...input, ...budget, sourceId: this.sourceId });
  }

  public provider(input: Omit<SyntheticNavigationBuildOptions, 'sourceId'>): SyntheticNavigationProvider {
    return new SyntheticNavigationProvider(this, input);
  }
}

/**
 * Read-only NavigationProvider backed by immutable synthetic input. Rebuild
 * returns a new provider and source generation; it never mutates the old one.
 */
export class SyntheticNavigationProvider implements NavigationProvider {
  public readonly sourceId: string;
  private readonly adapter: SyntheticNavigationAdapter;
  private readonly sourceGeneration: string;
  private readonly capturedAt: string;
  private readonly records: readonly unknown[];

  public constructor(adapter: SyntheticNavigationAdapter, input: Omit<SyntheticNavigationBuildOptions, 'sourceId'>) {
    this.adapter = adapter;
    this.sourceId = adapter.sourceId;
    assertOpaque(input.sourceGeneration, 'sourceGeneration');
    assertTimestamp(input.capturedAt, 'capturedAt');
    this.sourceGeneration = input.sourceGeneration;
    this.capturedAt = input.capturedAt;
    this.records = Object.freeze(input.records.map(cloneInputRecord));
  }

  public async readSnapshot(signal: AbortSignal, budget: Required<NavigationBudget>): Promise<NavigationSnapshot> {
    throwIfAborted(signal);
    const result = this.adapter.build(
      { sourceGeneration: this.sourceGeneration, capturedAt: this.capturedAt, records: this.records },
      { maxEntities: budget.maxEntities, maxRelations: budget.maxRelations },
    );
    throwIfAborted(signal);
    return result.index.snapshot;
  }

  public buildIndex(budget?: SyntheticNavigationBudget): SyntheticNavigationIndex {
    return this.adapter.build(
      { sourceGeneration: this.sourceGeneration, capturedAt: this.capturedAt, records: this.records },
      budget,
    ).index;
  }

  public rebuild(input: Omit<SyntheticNavigationBuildOptions, 'sourceId'>): SyntheticNavigationProvider {
    return new SyntheticNavigationProvider(this.adapter, input);
  }
}

interface ParsedRecord {
  readonly entity: NavigationEntity;
  readonly parentId?: string;
  readonly relations: readonly { readonly from: string; readonly to: string; readonly kind: SyntheticEdgeKind }[];
}

function parseRecord(
  raw: unknown,
  index: number,
  sourceId: string,
  diagnostics: SyntheticDiagnostic[],
): ParsedRecord | undefined {
  if (!isRecord(raw)) {
    diagnostics.push({ index, code: 'malformed', reason: 'record_not_object' });
    return undefined;
  }
  const type = raw.type;
  if (typeof type !== 'string') {
    diagnostics.push({ index, code: 'malformed', reason: 'missing_id' });
    return undefined;
  }
  if (!SUPPORTED_TYPES.has(type as SyntheticNodeKind)) {
    diagnostics.push({ index, code: 'unsupported', reason: 'unsupported_type' });
    return undefined;
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    diagnostics.push({ index, code: 'malformed', reason: 'missing_id' });
    return undefined;
  }
  if (!ID_PATTERN.test(raw.id)) {
    diagnostics.push({ index, code: 'malformed', reason: 'invalid_id' });
    return undefined;
  }
  const label = raw.label === undefined ? type + ' ' + raw.id : raw.label;
  if (typeof label !== 'string' || !isSafeLabel(label)) {
    diagnostics.push({ index, code: 'malformed', reason: 'invalid_label' });
    return undefined;
  }
  const parentId = raw.parentId;
  if (parentId !== undefined && (typeof parentId !== 'string' || !ID_PATTERN.test(parentId))) {
    diagnostics.push({ index, code: 'malformed', reason: 'invalid_parent' });
    return undefined;
  }
  const updatedAt = raw.updatedAt;
  if (updatedAt !== undefined && (typeof updatedAt !== 'string' || !isSafeTimestamp(updatedAt))) {
    diagnostics.push({ index, code: 'malformed', reason: 'invalid_timestamp' });
    return undefined;
  }
  const status = raw.status;
  if (status !== undefined && (typeof status !== 'string' || status.length > MAX_STATUS_LENGTH || CONTROL_PATTERN.test(status))) {
    diagnostics.push({ index, code: 'malformed', reason: 'invalid_status' });
    return undefined;
  }
  const confidence = raw.confidence;
  if (confidence !== undefined && confidence !== 'source' && confidence !== 'correlated' && confidence !== 'inferred') {
    diagnostics.push({ index, code: 'malformed', reason: 'invalid_confidence' });
    return undefined;
  }
  const relations = parseRelations(raw.relations, raw.id, index, diagnostics);
  const entity: NavigationEntity = {
    sourceId,
    nativeId: raw.id,
    kind: type as SyntheticNodeKind,
    label,
    confidence: confidence ?? 'source',
    ...(parentId === undefined ? {} : { parentNativeId: parentId }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(status === undefined ? {} : { status }),
  };
  return { entity, ...(parentId === undefined ? {} : { parentId }), relations };
}

function parseRelations(
  raw: unknown,
  from: string,
  index: number,
  diagnostics: SyntheticDiagnostic[],
): readonly { readonly from: string; readonly to: string; readonly kind: SyntheticEdgeKind }[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push({ index, code: 'malformed', reason: 'invalid_relation' });
    return [];
  }
  const relations: Array<{ readonly from: string; readonly to: string; readonly kind: SyntheticEdgeKind }> = [];
  for (const candidate of raw.slice(0, MAX_RECORD_RELATIONS)) {
    if (!isRecord(candidate) || typeof candidate.kind !== 'string' || !SUPPORTED_RELATIONS.has(candidate.kind as SyntheticEdgeKind) || typeof candidate.targetId !== 'string' || !ID_PATTERN.test(candidate.targetId)) {
      diagnostics.push({ index, code: 'malformed', reason: 'invalid_relation' });
      continue;
    }
    relations.push({ from, to: candidate.targetId, kind: candidate.kind as SyntheticEdgeKind });
  }
  return relations;
}

function createSnapshotId(
  sourceId: string,
  sourceGeneration: string,
  entities: readonly NavigationEntity[],
  relations: readonly NavigationRelation[],
  maxEntities: number,
  maxRelations: number,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ sourceId, sourceGeneration, maxEntities, maxRelations, entities, relations }), 'utf8')
    .digest('hex');
  return 'synthetic-' + digest.slice(0, 32);
}

function normalizeBudget(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new Error('Synthetic ' + name + ' must be an integer between 1 and ' + String(maximum) + '.');
  }
  return normalized;
}

function assertOpaque(value: string, name: string): void {
  if (!ID_PATTERN.test(value)) throw new Error('Synthetic ' + name + ' must be an opaque identifier.');
}

function assertTimestamp(value: string, name: string): void {
  if (!isSafeTimestamp(value)) throw new Error('Synthetic ' + name + ' must be a bounded timestamp.');
}

function isSafeTimestamp(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TIMESTAMP_LENGTH && !CONTROL_PATTERN.test(value);
}

function isSafeLabel(value: string): boolean {
  return value.length > 0 && value.length <= MAX_LABEL_LENGTH && !CONTROL_PATTERN.test(value) && !PATH_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copy only the adapter input shape so later caller mutations cannot alter a provider. */
function cloneInputRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const clone: Record<string, unknown> = {};
  for (const key of ['type', 'id', 'label', 'parentId', 'updatedAt', 'status', 'confidence'] as const) {
    if (key in value) clone[key] = value[key];
  }
  const relations = value.relations;
  if (Array.isArray(relations)) {
    clone.relations = Object.freeze(relations.map((relation) => {
      if (!isRecord(relation)) return relation;
      return Object.freeze({ kind: relation.kind, targetId: relation.targetId });
    }));
  } else if (relations !== undefined) {
    clone.relations = relations;
  }
  return Object.freeze(clone);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Synthetic navigation query cancelled.');
}
