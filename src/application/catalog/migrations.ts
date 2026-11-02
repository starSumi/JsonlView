import type {
  CatalogEntityInput,
  CatalogEntityKind,
  CatalogLocation,
  CatalogProviderId,
  CatalogRelation,
  CatalogRelationKind,
  CatalogSnapshot,
} from './catalog-model';

/** A versioned transformation from one persisted catalog shape to the next. */
export interface CatalogMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly description: string;
  readonly migrate: (oldData: unknown) => Promise<CatalogSnapshot>;
  readonly validate: (data: unknown) => boolean;
  readonly rollback?: (newData: CatalogSnapshot) => Promise<unknown>;
}

export type CatalogMigrationErrorCode =
  | 'invalid-input'
  | 'invalid-target-version'
  | 'unsupported-version'
  | 'downgrade-not-supported'
  | 'missing-migration'
  | 'invalid-migration'
  | 'migration-failed'
  | 'validation-failed'
  | 'migration-cycle';

export class CatalogMigrationError extends Error {
  readonly code: CatalogMigrationErrorCode;
  override readonly cause?: unknown;

  constructor(code: CatalogMigrationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'CatalogMigrationError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const PROVIDERS: readonly CatalogProviderId[] = ['codex', 'claude', 'pi', 'kimi', 'gemini', 'opencode', 'agentsview', 'generic'];
const ENTITY_KINDS: readonly CatalogEntityKind[] = ['source', 'session', 'thread', 'turn', 'workflow', 'team', 'tool', 'goal', 'plan', 'memory', 'task', 'subagent', 'event', 'other'];
const RELATION_KINDS: readonly CatalogRelationKind[] = ['parent', 'child', 'fork', 'spawn', 'contains', 'uses'];
const TITLE_SOURCES = ['product', 'provider', 'first-message', 'id'] as const;
const RELATIONSHIPS = ['root', 'subagent', 'fork', 'continuation', 'orphan', 'generic'] as const;
const TRUNCATION_REASONS = ['entity_limit', 'relation_limit', 'record_limit', 'diagnostic_limit', 'time_limit'] as const;

/** The current persisted catalog format. */
export const CATALOG_VERSION = 2 as const;

/** The built-in chain is intentionally one version step at a time. */
export const CATALOG_MIGRATIONS: readonly CatalogMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Declare the version 2 metadata-only catalog snapshot shape',
    migrate: async (oldData) => {
      if (!isCatalogSnapshotVersion(oldData, 1)) {
        throw new Error('Expected a valid catalog snapshot version 1');
      }
      return { ...oldData, schemaVersion: 2 };
    },
    validate: (data) => isCatalogSnapshotVersion(data, 2),
  },
];

/** Read a version field without accepting strings, fractions, or unsafe values. */
export function getCatalogVersion(data: unknown): number {
  if (!isRecord(data)) {
    throw new CatalogMigrationError('invalid-input', 'Catalog data must declare a positive integer schemaVersion');
  }
  const version = data.schemaVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new CatalogMigrationError('invalid-input', 'Catalog data must declare a positive integer schemaVersion');
  }
  return version;
}

/** Runtime guard used at the migration boundary and by migration validators. */
export function isCatalogSnapshot(data: unknown): data is CatalogSnapshot {
  if (!isRecord(data)) return false;
  const version = data.schemaVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return false;
  return isCatalogSnapshotBody(data);
}

export function validateCatalogSnapshot(data: unknown): boolean {
  return isCatalogSnapshot(data);
}

/**
 * Migrate a catalog through every contiguous version step up to targetVersion.
 * The function rejects malformed input, gaps, non-incrementing migrations,
 * failed postconditions, and downgrade requests instead of silently casting.
 */
export async function migrateCatalog(
  data: unknown,
  targetVersion: number,
  migrations: readonly CatalogMigration[] = CATALOG_MIGRATIONS,
): Promise<CatalogSnapshot> {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    throw new CatalogMigrationError('invalid-target-version', 'targetVersion must be a positive safe integer');
  }

  const initialVersion = getCatalogVersion(data);
  if (!isCatalogSnapshot(data)) {
    throw new CatalogMigrationError('invalid-input', `Catalog schema version ${initialVersion} failed runtime validation`);
  }
  if (initialVersion > targetVersion) {
    throw new CatalogMigrationError('downgrade-not-supported', `Cannot migrate catalog from version ${initialVersion} down to ${targetVersion}`);
  }
  if (initialVersion > CATALOG_VERSION && !migrations.some((migration) => migration.fromVersion === initialVersion)) {
    throw new CatalogMigrationError('unsupported-version', `Catalog schema version ${initialVersion} is not supported`);
  }
  if (initialVersion === targetVersion) return data;

  let current: unknown = data;
  let currentVersion = initialVersion;
  const visited = new Set<number>();

  while (currentVersion < targetVersion) {
    if (visited.has(currentVersion)) {
      throw new CatalogMigrationError('migration-cycle', `Migration chain revisited version ${currentVersion}`);
    }
    visited.add(currentVersion);

    const candidates = migrations.filter((migration) => migration.fromVersion === currentVersion);
    if (candidates.length === 0) {
      throw new CatalogMigrationError('missing-migration', `No migration is registered from catalog version ${currentVersion}`);
    }
    if (candidates.length > 1) {
      throw new CatalogMigrationError('invalid-migration', `Multiple migrations are registered from catalog version ${currentVersion}`);
    }

    const migration = candidates[0]!;
    if (
      !Number.isSafeInteger(migration.fromVersion)
      || !Number.isSafeInteger(migration.toVersion)
      || migration.fromVersion !== currentVersion
      || migration.toVersion !== migration.fromVersion + 1
    ) {
      throw new CatalogMigrationError('invalid-migration', `Migration ${migration.fromVersion}->${migration.toVersion} is not a contiguous increment`);
    }

    let migrated: CatalogSnapshot;
    try {
      migrated = await migration.migrate(current);
    } catch (error) {
      throw new CatalogMigrationError(
        'migration-failed',
        `Migration ${migration.fromVersion}->${migration.toVersion} failed`,
        error,
      );
    }

    let valid = false;
    try {
      valid = migration.validate(migrated);
    } catch (error) {
      throw new CatalogMigrationError(
        'validation-failed',
        `Migration ${migration.fromVersion}->${migration.toVersion} validator threw`,
        error,
      );
    }
    if (!valid) {
      throw new CatalogMigrationError(
        'validation-failed',
        `Migration ${migration.fromVersion}->${migration.toVersion} produced data rejected by validate`,
      );
    }
    if (!isCatalogSnapshot(migrated) || migrated.schemaVersion !== migration.toVersion) {
      throw new CatalogMigrationError(
        'validation-failed',
        `Migration ${migration.fromVersion}->${migration.toVersion} produced an invalid or mismatched snapshot`,
      );
    }

    current = migrated;
    currentVersion = migrated.schemaVersion;
  }

  if (!isCatalogSnapshot(current) || current.schemaVersion !== targetVersion) {
    throw new CatalogMigrationError('validation-failed', `Migration did not reach target version ${targetVersion}`);
  }
  return current;
}

function isCatalogSnapshotVersion(data: unknown, version: 1 | 2): data is CatalogSnapshot {
  return isCatalogSnapshot(data) && data.schemaVersion === version;
}

function isCatalogSnapshotBody(data: Record<string, unknown>): boolean {
  return isOneOf(data.provider, PROVIDERS)
    && isString(data.sourceId)
    && isString(data.sourceGeneration)
    && isString(data.snapshotId)
    && isString(data.capturedAt)
    && data.redaction === 'metadata-only'
    && Array.isArray(data.entities)
    && data.entities.every(isCatalogEntityInput)
    && Array.isArray(data.relations)
    && data.relations.every(isCatalogRelation)
    && Array.isArray(data.locations)
    && data.locations.every(isCatalogLocation)
    && typeof data.truncated === 'boolean'
    && optionalOneOf(data.truncatedReason, TRUNCATION_REASONS)
    && optionalString(data.nextCursor);
}

function isCatalogEntityInput(value: unknown): value is CatalogEntityInput {
  if (!isRecord(value)) return false;
  return isString(value.sourceId)
    && isString(value.nativeId)
    && isOneOf(value.kind, ENTITY_KINDS)
    && isString(value.label)
    && optionalString(value.vendorTitle)
    && optionalString(value.productTitle)
    && optionalOneOf(value.titleSource, TITLE_SOURCES)
    && optionalString(value.firstMessagePreview)
    && optionalString(value.startedAt)
    && optionalString(value.activityAt)
    && optionalOneOf(value.relationship, RELATIONSHIPS)
    && optionalString(value.project)
    && optionalString(value.parentNativeId)
    && optionalString(value.updatedAt)
    && optionalString(value.status)
    && isOneOf(value.confidence, ['source', 'correlated', 'inferred'] as const)
    && optionalString(value.opaqueRef);
}

function isCatalogRelation(value: unknown): value is CatalogRelation {
  return isRecord(value)
    && isString(value.sourceId)
    && isString(value.fromNativeId)
    && isString(value.toNativeId)
    && isOneOf(value.kind, RELATION_KINDS);
}

function isCatalogLocation(value: unknown): value is CatalogLocation {
  return isRecord(value)
    && isString(value.nativeId)
    && isString(value.relativePath)
    && isString(value.rowOrdinal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function optionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function optionalOneOf<T extends string>(value: unknown, values: readonly T[]): boolean {
  return value === undefined || isOneOf(value, values);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
