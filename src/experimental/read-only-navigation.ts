import {
  NAVIGATION_PROTOCOL_VERSION,
  type NavigationBudget,
  type NavigationEntity,
  type NavigationProvider,
  type NavigationQuery,
  type NavigationQueryResult,
  type NavigationRelation,
  type NavigationSnapshot,
} from './navigation-contract';

const DEFAULT_BUDGET: Required<NavigationBudget> = {
  maxEntities: 500,
  maxRelations: 2_000,
  maxRecords: 2_000,
  maxDiagnostics: 1_000,
  maxMilliseconds: 1_000,
};
const MAX_BUDGET: Required<NavigationBudget> = {
  maxEntities: 10_000,
  maxRelations: 50_000,
  maxRecords: 50_000,
  maxDiagnostics: 10_000,
  maxMilliseconds: 10_000,
};
const MAX_METADATA_LABEL_LENGTH = 256;
const MAX_METADATA_LABEL_BYTES = 1_024;
const MAX_OPAQUE_REF_BYTES = 2_048;
const MAX_PINNED_SNAPSHOTS = 32;

export interface NavigationClock {
  now(): number;
}

export interface NavigationFacadeOptions {
  providers: readonly NavigationProvider[];
  allowedSourceIds: readonly string[];
  clock?: NavigationClock;
}

/**
 * Read-only control-plane facade used by a future MCP transport or TreeView.
 * It has no filesystem, process, network, or VS Code dependency.
 */
export class ReadOnlyNavigationFacade {
  private readonly providers: ReadonlyMap<string, NavigationProvider>;
  private readonly allowedSourceIds: ReadonlySet<string>;
  private readonly clock: NavigationClock;
  private readonly snapshots = new Map<string, NavigationSnapshot>();

  public constructor(options: NavigationFacadeOptions) {
    const providers = new Map<string, NavigationProvider>();
    for (const provider of options.providers) {
      if (providers.has(provider.sourceId)) throw new Error(`Duplicate navigation source: ${provider.sourceId}`);
      providers.set(provider.sourceId, provider);
    }
    this.providers = providers;
    this.allowedSourceIds = new Set(options.allowedSourceIds);
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  public async query(
    operationId: string,
    query: NavigationQuery,
    signal: AbortSignal,
  ): Promise<NavigationQueryResult> {
    assertOperationId(operationId);
    throwIfCancelled(signal);
    const sourceId = query.sourceId ?? this.onlyAllowedSource();
    this.assertAllowed(sourceId);
    const budget = normalizeBudget(query.budget);
    const startedAt = this.clock.now();
    const snapshot = await this.getSnapshot(sourceId, query.snapshotId, signal, {
      ...budget,
      maxMilliseconds: Math.max(1, budget.maxMilliseconds - Math.max(0, this.clock.now() - startedAt)),
    });
    const deadline = startedAt + budget.maxMilliseconds;
    const limit = normalizeLimit(query.limit, budget.maxEntities);
    const offset = normalizeOffset(query.offset, budget.maxEntities);
    const text = query.text?.trim().toLocaleLowerCase();
    const entities: NavigationEntity[] = [];
    let examinedEntities = 0;
    let matchedEntities = 0;
    let truncated = snapshot.truncated;
    let truncatedReason: NavigationQueryResult['truncatedReason'] = snapshot.truncated ? (snapshot.truncatedReason ?? 'entity_limit') : undefined;

    for (const entity of snapshot.entities) {
      throwIfCancelled(signal);
      if (this.clock.now() >= deadline) {
        truncated = true;
        truncatedReason = 'time_limit';
        break;
      }
      examinedEntities += 1;
      if (query.kind !== undefined && entity.kind !== query.kind) continue;
      if (query.parentNativeId !== undefined && entity.parentNativeId !== query.parentNativeId) continue;
      if (text !== undefined && !entity.label.toLocaleLowerCase().includes(text)) continue;
      if (matchedEntities < offset) {
        matchedEntities += 1;
        continue;
      }
      if (entities.length >= limit) {
        truncated = true;
        truncatedReason = 'result_limit';
        break;
      }
      matchedEntities += 1;
      entities.push(entity);
    }

    const resultIds = new Set(entities.map((entity) => entity.nativeId));
    const relations: NavigationRelation[] = [];
    let examinedRelations = 0;
    for (const relation of snapshot.relations) {
      throwIfCancelled(signal);
      if (this.clock.now() >= deadline) {
        truncated = true;
        truncatedReason = 'time_limit';
        break;
      }
      examinedRelations += 1;
      if (relation.sourceId !== sourceId) continue;
      const inResult = resultIds.has(relation.fromNativeId) || resultIds.has(relation.toNativeId);
      if (!inResult) continue;
      relations.push(relation);
      if (relations.length >= budget.maxRelations) {
        truncated = true;
        truncatedReason = 'relation_limit';
        break;
      }
    }

    return {
      protocolVersion: NAVIGATION_PROTOCOL_VERSION,
      operationId,
      snapshotId: snapshot.snapshotId,
      sourceId,
      entities,
      relations,
      examinedEntities,
      examinedRelations,
      truncated,
      ...(truncatedReason === undefined ? {} : { truncatedReason }),
    };
  }

  private async getSnapshot(
    sourceId: string,
    snapshotId: string | undefined,
    signal: AbortSignal,
    budget: Required<NavigationBudget>,
  ): Promise<NavigationSnapshot> {
    throwIfCancelled(signal);
    if (snapshotId !== undefined) {
      const snapshot = this.snapshots.get(snapshotId);
      if (snapshot === undefined || snapshot.sourceId !== sourceId) throw new Error('Unknown navigation snapshot.');
      return snapshot;
    }
    if (signal.aborted) throw new Error('Navigation query cancelled.');
    const provider = this.providers.get(sourceId);
    if (provider === undefined) throw new Error(`Unknown navigation source: ${sourceId}`);
    const snapshot = await readSnapshotWithDeadline(provider, signal, budget);
    if (signal.aborted) throw new Error('Navigation query cancelled.');
    if (snapshot.sourceId !== sourceId || snapshot.redaction !== 'metadata-only') {
      throw new Error('Navigation provider returned an invalid or unredacted snapshot.');
    }
    if (snapshot.snapshotId.length === 0 || snapshot.snapshotId.length > 256 || snapshot.sourceGeneration.length === 0 || snapshot.sourceGeneration.length > 256 || snapshot.capturedAt.length === 0 || snapshot.capturedAt.length > 64) {
      throw new Error('Navigation provider returned an invalid snapshot identity.');
    }
    if (snapshot.entities.length > budget.maxEntities || snapshot.relations.length > budget.maxRelations) {
      throw new Error('Navigation provider exceeded its declared budget.');
    }
    validateMetadataSnapshot(snapshot);
    const pinned = pinSnapshot(snapshot);
    this.snapshots.set(pinned.snapshotId, pinned);
    while (this.snapshots.size > MAX_PINNED_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    return pinned;
  }

  private onlyAllowedSource(): string {
    if (this.allowedSourceIds.size !== 1) throw new Error('A source allowlist is required for multi-source navigation.');
    const sourceId = this.allowedSourceIds.values().next().value;
    if (sourceId === undefined) throw new Error('No navigation source is allowed.');
    return sourceId;
  }

  private assertAllowed(sourceId: string): void {
    if (!this.allowedSourceIds.has(sourceId)) throw new Error(`Navigation source is not allowlisted: ${sourceId}`);
  }
}

function normalizeBudget(value: NavigationBudget | undefined): Required<NavigationBudget> {
  const result = { ...DEFAULT_BUDGET, ...value };
  for (const key of ['maxEntities', 'maxRelations', 'maxRecords', 'maxDiagnostics', 'maxMilliseconds'] as const) {
    const candidate = result[key];
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_BUDGET[key]) {
      throw new Error(`Navigation ${key} must be an integer between 1 and ${String(MAX_BUDGET[key])}.`);
    }
  }
  return result;
}

function normalizeLimit(value: number | undefined, maximum: number): number {
  const limit = value ?? Math.min(100, maximum);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error('Navigation limit is outside the active budget.');
  return limit;
}

function normalizeOffset(value: number | undefined, maximum: number): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50_000 || offset > maximum * 100) {
    throw new Error('Navigation offset is outside the active budget.');
  }
  return offset;
}

function assertOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) throw new Error('Navigation operationId is invalid.');
}

function validateMetadataSnapshot(snapshot: NavigationSnapshot): void {
  if (!isOpaqueIdentifier(snapshot.sourceId) || !isOpaqueIdentifier(snapshot.snapshotId) || !isOpaqueIdentifier(snapshot.sourceGeneration)) {
    throw new Error('Navigation provider returned an invalid snapshot identity.');
  }
  for (const entity of snapshot.entities) {
    if (entity.sourceId !== snapshot.sourceId || !isOpaqueIdentifier(entity.nativeId) || byteLength(entity.nativeId) > 1_024) {
      throw new Error('Navigation provider returned an invalid entity identity.');
    }
    if (entity.parentNativeId !== undefined && !isOpaqueIdentifier(entity.parentNativeId)) {
      throw new Error('Navigation provider returned an invalid parent identity.');
    }
    if (entity.label.length === 0 || entity.label.length > MAX_METADATA_LABEL_LENGTH || byteLength(entity.label) > MAX_METADATA_LABEL_BYTES || /[\u0000-\u001f\u007f]/u.test(entity.label)) {
      throw new Error('Navigation provider returned an invalid metadata label.');
    }
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:\/\/)/u.test(entity.label)) {
      throw new Error('Navigation provider exposed a path in a metadata label.');
    }
    if (entity.opaqueRef !== undefined && (entity.opaqueRef.length === 0 || entity.opaqueRef.length > 512 || byteLength(entity.opaqueRef) > MAX_OPAQUE_REF_BYTES || /[\u0000-\u001f\u007f]/u.test(entity.opaqueRef) || /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:\/\/)/u.test(entity.opaqueRef))) {
      throw new Error('Navigation provider returned an invalid opaque reference.');
    }
    if (entity.status !== undefined && (entity.status.length > 128 || /[\u0000-\u001f\u007f]/u.test(entity.status))) {
      throw new Error('Navigation provider returned an invalid status.');
    }
    if (entity.updatedAt !== undefined && (entity.updatedAt.length === 0 || entity.updatedAt.length > 64 || /[\u0000-\u001f\u007f]/u.test(entity.updatedAt))) {
      throw new Error('Navigation provider returned an invalid timestamp.');
    }
  }
  for (const relation of snapshot.relations) {
    if (relation.sourceId !== snapshot.sourceId || !isOpaqueIdentifier(relation.fromNativeId) || !isOpaqueIdentifier(relation.toNativeId)) {
      throw new Error('Navigation provider returned an invalid relation.');
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Navigation query cancelled.');
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isOpaqueIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(value);
}

async function readSnapshotWithDeadline(
  provider: NavigationProvider,
  signal: AbortSignal,
  budget: Required<NavigationBudget>,
): Promise<NavigationSnapshot> {
  const controller = new AbortController();
  let rejectCancellation: ((reason?: unknown) => void) | undefined;
  const abort = (): void => {
    controller.abort();
    rejectCancellation?.(new Error('Navigation query cancelled.'));
  };
  if (signal.aborted) throw new Error('Navigation query cancelled.');
  signal.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Navigation provider exceeded its time budget.'));
    }, budget.maxMilliseconds);
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  try {
    return await Promise.race([provider.readSnapshot(controller.signal, budget), timeout, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function pinSnapshot(snapshot: NavigationSnapshot): NavigationSnapshot {
  const entities = snapshot.entities.map((entity) => Object.freeze({ ...entity }));
  const relations = snapshot.relations.map((relation) => Object.freeze({ ...relation }));
  return Object.freeze({ ...snapshot, entities: Object.freeze(entities), relations: Object.freeze(relations) });
}
