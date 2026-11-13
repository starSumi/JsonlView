import { describe, expect, it } from 'vitest';
import {
  CATALOG_MIGRATIONS,
  CatalogMigrationError,
  getCatalogVersion,
  isCatalogSnapshot,
  migrateCatalog,
} from '@application/catalog/migrations';
import type { CatalogSnapshot } from '@application/catalog/catalog-model';

function snapshot(schemaVersion = 1): CatalogSnapshot {
  return {
    schemaVersion,
    provider: 'generic',
    sourceId: 'source-1',
    sourceGeneration: 'generation-1',
    snapshotId: 'snapshot-1',
    capturedAt: '2026-11-02T00:00:00.000Z',
    redaction: 'metadata-only',
    entities: [{
      sourceId: 'source-1',
      nativeId: 'entity-1',
      kind: 'session',
      label: 'Session',
      confidence: 'source',
    }],
    relations: [],
    locations: [{ nativeId: 'entity-1', relativePath: 'session.jsonl', rowOrdinal: '0' }],
    truncated: false,
  };
}

function expectMigrationError(promise: Promise<unknown>, code: CatalogMigrationError['code']): Promise<void> {
  return expect(promise).rejects.toMatchObject({ name: 'CatalogMigrationError', code });
}

describe('catalog snapshot migrations', () => {
  it('migrates a valid v1 snapshot to v2 and validates its result', async () => {
    const migrated = await migrateCatalog(snapshot(), 2);

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.entities).toEqual(snapshot().entities);
    expect(isCatalogSnapshot(migrated)).toBe(true);
  });

  it('walks a contiguous multi-step chain without silently skipping a version', async () => {
    const migrations = [
      ...CATALOG_MIGRATIONS,
      {
        fromVersion: 2,
        toVersion: 3,
        description: 'fixture v2 to v3',
        migrate: async () => snapshot(3),
        validate: (data: unknown) => isCatalogSnapshot(data) && data.schemaVersion === 3,
      },
    ] as const;

    const migrated = await migrateCatalog(snapshot(), 3, migrations);

    expect(migrated.schemaVersion).toBe(3);
  });

  it('returns an already-targeted snapshot unchanged', async () => {
    const current = snapshot(2);

    await expect(migrateCatalog(current, 2)).resolves.toBe(current);
  });

  it('rejects unknown and malformed versions at the boundary', async () => {
    expect(() => getCatalogVersion({ schemaVersion: '1' })).toThrow(CatalogMigrationError);
    await expectMigrationError(migrateCatalog({ ...snapshot(), schemaVersion: 99 }, 100), 'unsupported-version');
    await expectMigrationError(migrateCatalog({ ...snapshot(), schemaVersion: 0 }, 1), 'invalid-input');
  });

  it('rejects a broken migration chain and downgrade requests', async () => {
    await expectMigrationError(migrateCatalog(snapshot(), 3, [
      { ...CATALOG_MIGRATIONS[0]!, toVersion: 3 },
    ]), 'invalid-migration');

    await expectMigrationError(migrateCatalog(snapshot(), 3, CATALOG_MIGRATIONS), 'missing-migration');
    await expectMigrationError(migrateCatalog(snapshot(2), 1), 'downgrade-not-supported');
  });

  it('rejects a migration whose postcondition validator refuses the result', async () => {
    await expectMigrationError(migrateCatalog(snapshot(), 2, [{
      ...CATALOG_MIGRATIONS[0]!,
      validate: () => false,
    }]), 'validation-failed');
  });

  it('wraps migration failures and rejects non-contiguous or cyclic steps', async () => {
    await expectMigrationError(migrateCatalog(snapshot(), 2, [{
      ...CATALOG_MIGRATIONS[0]!,
      migrate: async () => { throw new Error('fixture failure'); },
    }]), 'migration-failed');

    await expectMigrationError(migrateCatalog(snapshot(), 2, [{
      fromVersion: 1,
      toVersion: 1,
      description: 'self-cycle',
      migrate: async () => snapshot(1),
      validate: () => true,
    }]), 'invalid-migration');
  });
});
