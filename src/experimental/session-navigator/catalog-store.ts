import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NavigatorEntity, NavigatorLocation, NavigatorSnapshot, NavigatorSourceSummary, SessionNavigatorProviderId, SessionNavigatorSortKey } from './types';
import type { AuthorizedSourceSetting } from './types';
import { sourceIdFor, sourceLabelFor } from './source-config';

const MAX_TREE_CHILDREN = 2_000;

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
  vendor_title: string | null;
  title_source: string | null;
  first_message_preview: string | null;
  started_at: string | null;
  activity_at: string | null;
  relationship: string | null;
  project: string | null;
  product_title: string | null;
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
        vendor_title TEXT,
        title_source TEXT,
        first_message_preview TEXT,
        started_at TEXT,
        activity_at TEXT,
        relationship TEXT NOT NULL DEFAULT 'generic',
        project TEXT,
        PRIMARY KEY (source_id, generation, native_id)
      );
      CREATE TABLE IF NOT EXISTS entity_labels (
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        native_id TEXT NOT NULL,
        product_title TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, native_id)
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
      INSERT OR IGNORE INTO catalog_meta(key, value) VALUES ('schema_version', '2');
    `);
    ensureColumn(db, 'entities', 'vendor_title', 'TEXT');
    ensureColumn(db, 'entities', 'title_source', 'TEXT');
    ensureColumn(db, 'entities', 'first_message_preview', 'TEXT');
    ensureColumn(db, 'entities', 'started_at', 'TEXT');
    ensureColumn(db, 'entities', 'activity_at', 'TEXT');
    ensureColumn(db, 'entities', 'relationship', "TEXT NOT NULL DEFAULT 'generic'");
    ensureColumn(db, 'entities', 'project', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS entities_activity_idx ON entities(source_id, generation, activity_at, started_at, native_id);');
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
        ...lastActivityFor(this.#db, row.source_id, generationText(row.generation)),
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

  public getChildren(sourceId: string, parentNativeId?: string, sortKey: SessionNavigatorSortKey = 'activity'): readonly NavigatorEntity[] {
    const source = this.#sourceRow(sourceId);
    if (source === undefined || source.generation < 1) return [];
    const generation = generationText(source.generation);
    const orderBy = orderByFor(sortKey);
    const query = parentNativeId === undefined
      ? `SELECT e.*, l.product_title FROM entities e LEFT JOIN entity_labels l ON l.source_id = e.source_id AND l.native_id = e.native_id WHERE e.source_id = ? AND e.generation = ? AND e.parent_native_id IS NULL ORDER BY ${orderBy} LIMIT ${MAX_TREE_CHILDREN}`
      : `SELECT e.*, l.product_title FROM entities e LEFT JOIN entity_labels l ON l.source_id = e.source_id AND l.native_id = e.native_id WHERE e.source_id = ? AND e.generation = ? AND e.parent_native_id = ? ORDER BY ${orderBy} LIMIT ${MAX_TREE_CHILDREN}`;
    const rows = parentNativeId === undefined
      ? this.#db.prepare(query).all(sourceId, generation)
      : this.#db.prepare(query).all(sourceId, generation, parentNativeId);
    return (rows as unknown as EntityRow[]).map((row) => toEntity(row, source.provider as SessionNavigatorProviderId));
  }

  public hasChildren(sourceId: string, nativeId: string): boolean {
    const source = this.#sourceRow(sourceId);
    if (source === undefined || source.generation < 1) return false;
    const row = this.#db.prepare('SELECT 1 AS found FROM entities WHERE source_id = ? AND generation = ? AND parent_native_id = ? LIMIT 1').get(sourceId, generationText(source.generation), nativeId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  public setProductTitle(sourceId: string, nativeId: string, title: string): void {
    const value = title.trim().slice(0, 160);
    if (value.length === 0) {
      this.clearProductTitle(sourceId, nativeId);
      return;
    }
    this.#db.prepare(`INSERT INTO entity_labels(source_id, native_id, product_title, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, native_id) DO UPDATE SET product_title = excluded.product_title, updated_at = excluded.updated_at`).run(sourceId, nativeId, value, new Date().toISOString());
  }

  public clearProductTitle(sourceId: string, nativeId: string): void {
    this.#db.prepare('DELETE FROM entity_labels WHERE source_id = ? AND native_id = ?').run(sourceId, nativeId);
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
      const insertEntity = this.#db.prepare(`INSERT INTO entities(
        source_id, generation, native_id, kind, label, parent_native_id, updated_at, status, confidence, opaque_ref,
        vendor_title, title_source, first_message_preview, started_at, activity_at, relationship, project
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entity of nextSnapshot.entities) {
        insertEntity.run(
          sourceId, generation, entity.nativeId, entity.kind, entity.label, entity.parentNativeId ?? null, entity.updatedAt ?? null,
          entity.status ?? null, entity.confidence, entity.opaqueRef ?? null, entity.vendorTitle ?? null, entity.titleSource ?? null,
          entity.firstMessagePreview ?? null, entity.startedAt ?? null, entity.activityAt ?? entity.updatedAt ?? null,
          entity.relationship ?? 'generic', entity.project ?? null,
        );
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

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function orderByFor(sortKey: SessionNavigatorSortKey): string {
  switch (sortKey) {
    case 'created':
      return "COALESCE(e.started_at, e.updated_at, '') DESC, e.native_id ASC";
    case 'title':
      return "COALESCE(l.product_title, e.vendor_title, e.label) COLLATE NOCASE ASC, e.native_id ASC";
    case 'activity':
    default:
      return "COALESCE(e.activity_at, e.updated_at, e.started_at, '') DESC, e.native_id ASC";
  }
}

function lastActivityFor(db: DatabaseSync, sourceId: string, generation: string): { lastActivityAt?: string } {
  const row = db.prepare('SELECT MAX(COALESCE(activity_at, updated_at, started_at)) AS value FROM entities WHERE source_id = ? AND generation = ?').get(sourceId, generation) as { value?: string | null } | undefined;
  return row?.value ? { lastActivityAt: row.value } : {};
}

function toEntity(row: EntityRow, provider: SessionNavigatorProviderId): NavigatorEntity {
  const productTitle = row.product_title ?? undefined;
  const vendorTitle = row.vendor_title ?? undefined;
  const firstMessagePreview = row.first_message_preview ?? undefined;
  const label = productTitle ?? vendorTitle ?? firstMessagePreview ?? row.label;
  return {
    sourceId: row.source_id,
    nativeId: row.native_id,
    kind: row.kind as NavigatorEntity['kind'],
    label,
    ...(vendorTitle === undefined ? {} : { vendorTitle }),
    ...(productTitle === undefined ? {} : { productTitle }),
    ...(row.title_source === null ? {} : { titleSource: row.title_source as NonNullable<NavigatorEntity['titleSource']> }),
    ...(firstMessagePreview === undefined ? {} : { firstMessagePreview }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.activity_at === null ? {} : { activityAt: row.activity_at }),
    ...(row.relationship === null ? {} : { relationship: row.relationship as NonNullable<NavigatorEntity['relationship']> }),
    ...(row.project === null ? {} : { project: row.project }),
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
