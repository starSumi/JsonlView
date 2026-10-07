import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NavigatorEntity, NavigatorLocation, NavigatorSnapshot, NavigatorSourceSummary, SessionNavigatorProviderId } from './types';
import type { AuthorizedSourceSetting } from './types';
import { sourceIdFor, sourceLabelFor } from './source-config';

interface SourceRow {
  source_id: string;
  provider: string;
  label: string;
  root_uri: string;
  generation: number;
  captured_at: string | null;
  fingerprint: string | null;
  update_available: number;
}

interface EntityRow {
  source_id: string;
  generation: string;
  native_id: string;
  kind: string;
  label: string;
  parent_native_id: string | null;
  updated_at: string | null;
  status: string | null;
  confidence: string;
  opaque_ref: string | null;
}

interface RelationRow {
  source_id: string;
  from_native_id: string;
  to_native_id: string;
  kind: string;
}

interface LocationRow {
  native_id: string;
  relative_path: string;
  row_ordinal: string;
}

export class CatalogStore {
  readonly #db: DatabaseSync;
  readonly #path: string;

  private constructor(path: string, db: DatabaseSync) {
    this.#path = path;
    this.#db = db;
  }

  public static async open(path: string): Promise<CatalogStore> {
    await mkdir(dirname(path), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { timeout: 3_000 });
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        root_uri TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        captured_at TEXT,
        fingerprint TEXT,
        update_available INTEGER NOT NULL DEFAULT 0 CHECK (update_available IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS entities (
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        generation TEXT NOT NULL,
        native_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        parent_native_id TEXT,
        updated_at TEXT,
        status TEXT,
        confidence TEXT NOT NULL,
        opaque_ref TEXT,
        PRIMARY KEY (source_id, generation, native_id)
      );
      CREATE TABLE IF NOT EXISTS relations (
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        generation TEXT NOT NULL,
        from_native_id TEXT NOT NULL,
        to_native_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (source_id, generation, from_native_id, to_native_id, kind)
      );
      CREATE TABLE IF NOT EXISTS locations (
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        generation TEXT NOT NULL,
        native_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        row_ordinal TEXT NOT NULL,
        PRIMARY KEY (source_id, generation, native_id)
      );
      CREATE INDEX IF NOT EXISTS entities_parent_idx ON entities(source_id, generation, parent_native_id, label);
      CREATE INDEX IF NOT EXISTS entities_label_idx ON entities(source_id, generation, label);
      INSERT OR IGNORE INTO catalog_meta(key, value) VALUES ('schema_version', '1');
    `);
    return new CatalogStore(path, db);
  }

  public get path(): string { return this.#path; }

  public syncSources(settings: readonly AuthorizedSourceSetting[]): void {
    const active = new Set(settings.map(sourceIdFor));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.#db.prepare(`INSERT INTO sources(source_id, provider, label, root_uri) VALUES (?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET provider = excluded.provider, label = excluded.label, root_uri = excluded.root_uri`);
      for (const setting of settings) {
        upsert.run(sourceIdFor(setting), setting.provider, sourceLabelFor(setting), setting.rootUri);
      }
      const rows = this.#db.prepare('SELECT source_id FROM sources').all() as Array<{ source_id: string }>;
      const remove = this.#db.prepare('DELETE FROM sources WHERE source_id = ?');
      for (const row of rows) if (!active.has(row.source_id)) remove.run(row.source_id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  public listSources(): readonly NavigatorSourceSummary[] {
    const rows = this.#db.prepare('SELECT source_id, provider, label, generation, captured_at, update_available FROM sources ORDER BY label COLLATE NOCASE').all() as Array<Pick<SourceRow, 'source_id' | 'provider' | 'label' | 'generation' | 'captured_at' | 'update_available'>>;
    return rows.map((row) => {
      const counts = this.#db.prepare('SELECT (SELECT COUNT(*) FROM entities WHERE source_id = ? AND generation = ?) AS entities, (SELECT COUNT(*) FROM relations WHERE source_id = ? AND generation = ?) AS relations').get(row.source_id, generationText(row.generation), row.source_id, generationText(row.generation)) as { entities: number; relations: number };
      return {
        sourceId: row.source_id,
        provider: row.provider as SessionNavigatorProviderId,
        label: row.label,
        generation: generationText(row.generation),
        ...(row.captured_at === null ? {} : { capturedAt: row.captured_at }),
        entityCount: Number(counts.entities ?? 0),
        relationCount: Number(counts.relations ?? 0),
        updateAvailable: row.update_available === 1,
      };
    });
  }

  public getSourceRoot(sourceId: string): string | undefined {
    const row = this.#db.prepare('SELECT root_uri FROM sources WHERE source_id = ?').get(sourceId) as { root_uri?: string } | undefined;
    return row?.root_uri;
  }

  public getSourceProvider(sourceId: string): SessionNavigatorProviderId | undefined {
    const row = this.#db.prepare('SELECT provider FROM sources WHERE source_id = ?').get(sourceId) as { provider?: string } | undefined;
    return row?.provider as SessionNavigatorProviderId | undefined;
  }

  public getFingerprint(sourceId: string): string | undefined {
    const row = this.#db.prepare('SELECT fingerprint FROM sources WHERE source_id = ?').get(sourceId) as { fingerprint?: string | null } | undefined;
    return row?.fingerprint ?? undefined;
  }

  public getChildren(sourceId: string, parentNativeId?: string): readonly NavigatorEntity[] {
    const source = this.#sourceRow(sourceId);
    if (source === undefined || source.generation < 1) return [];
    const generation = generationText(source.generation);
    const rows = parentNativeId === undefined
      ? this.#db.prepare('SELECT * FROM entities WHERE source_id = ? AND generation = ? AND parent_native_id IS NULL ORDER BY updated_at DESC, label LIMIT 100').all(sourceId, generation)
      : this.#db.prepare('SELECT * FROM entities WHERE source_id = ? AND generation = ? AND parent_native_id = ? ORDER BY updated_at DESC, label LIMIT 100').all(sourceId, generation, parentNativeId);
    return (rows as unknown as EntityRow[]).map((row) => toEntity(row, source.provider as SessionNavigatorProviderId));
  }

  public hasChildren(sourceId: string, nativeId: string): boolean {
    const source = this.#sourceRow(sourceId);
    if (source === undefined || source.generation < 1) return false;
    const row = this.#db.prepare('SELECT 1 AS found FROM entities WHERE source_id = ? AND generation = ? AND parent_native_id = ? LIMIT 1').get(sourceId, generationText(source.generation), nativeId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  public getLocation(intent: { sourceId: string; generation: string; nativeId: string }): NavigatorLocation | undefined {
    const row = this.#db.prepare('SELECT native_id, relative_path, row_ordinal FROM locations WHERE source_id = ? AND generation = ? AND native_id = ?').get(intent.sourceId, intent.generation, intent.nativeId) as LocationRow | undefined;
    if (row === undefined) return undefined;
    return { nativeId: row.native_id, relativePath: row.relative_path, rowOrdinal: row.row_ordinal };
  }

  public replaceSnapshot(sourceId: string, snapshot: NavigatorSnapshot, fingerprint: string): NavigatorSnapshot {
    const source = this.#sourceRow(sourceId);
    if (source === undefined) throw new Error('Navigation source is not configured.');
    const nextGeneration = source.generation + 1;
    const generation = generationText(nextGeneration);
    const nextSnapshot: NavigatorSnapshot = Object.freeze({
      ...snapshot,
      sourceGeneration: generation,
      snapshotId: snapshotId(sourceId, generation, snapshot),
      locations: Object.freeze(snapshot.locations.map((location) => Object.freeze({ ...location }))),
    });
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM entities WHERE source_id = ?').run(sourceId);
      this.#db.prepare('DELETE FROM relations WHERE source_id = ?').run(sourceId);
      this.#db.prepare('DELETE FROM locations WHERE source_id = ?').run(sourceId);
      const insertEntity = this.#db.prepare('INSERT INTO entities(source_id, generation, native_id, kind, label, parent_native_id, updated_at, status, confidence, opaque_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const entity of nextSnapshot.entities) {
        insertEntity.run(sourceId, generation, entity.nativeId, entity.kind, entity.label, entity.parentNativeId ?? null, entity.updatedAt ?? null, entity.status ?? null, entity.confidence, entity.opaqueRef ?? null);
      }
      const insertRelation = this.#db.prepare('INSERT OR IGNORE INTO relations(source_id, generation, from_native_id, to_native_id, kind) VALUES (?, ?, ?, ?, ?)');
      for (const relation of nextSnapshot.relations) insertRelation.run(sourceId, generation, relation.fromNativeId, relation.toNativeId, relation.kind);
      const insertLocation = this.#db.prepare('INSERT OR REPLACE INTO locations(source_id, generation, native_id, relative_path, row_ordinal) VALUES (?, ?, ?, ?, ?)');
      for (const location of nextSnapshot.locations) insertLocation.run(sourceId, generation, location.nativeId, location.relativePath, location.rowOrdinal);
      this.#db.prepare('UPDATE sources SET generation = ?, captured_at = ?, fingerprint = ?, update_available = 0 WHERE source_id = ?').run(nextGeneration, nextSnapshot.capturedAt, fingerprint, sourceId);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return nextSnapshot;
  }

  public markUpdateAvailable(sourceId: string, available: boolean): void {
    this.#db.prepare('UPDATE sources SET update_available = ? WHERE source_id = ?').run(available ? 1 : 0, sourceId);
  }

  public close(): void { this.#db.close(); }

  #sourceRow(sourceId: string): SourceRow | undefined {
    return this.#db.prepare('SELECT * FROM sources WHERE source_id = ?').get(sourceId) as SourceRow | undefined;
  }
}

function generationText(value: number | string): string { return `g-${String(value)}`; }

function toEntity(row: EntityRow, provider: SessionNavigatorProviderId): NavigatorEntity {
  return {
    sourceId: row.source_id,
    nativeId: row.native_id,
    kind: row.kind as NavigatorEntity['kind'],
    label: row.label,
    confidence: row.confidence as NavigatorEntity['confidence'],
    generation: row.generation,
    provider,
    ...(row.parent_native_id === null ? {} : { parentNativeId: row.parent_native_id }),
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.opaque_ref === null ? {} : { opaqueRef: row.opaque_ref }),
  };
}

function snapshotId(sourceId: string, generation: string, snapshot: NavigatorSnapshot): string {
  return `catalog-${createHash('sha256').update(JSON.stringify({ sourceId, generation, capturedAt: snapshot.capturedAt, entities: snapshot.entities.length, relations: snapshot.relations.length }), 'utf8').digest('hex').slice(0, 32)}`;
}
