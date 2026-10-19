import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  CatalogAppendGuard,
  CatalogChildrenPage,
  CatalogChildrenPageOptions,
  CatalogCheckpoint,
  CatalogContinuationExpectation,
  CatalogEntity,
  CatalogLocation,
  CatalogNavigatorSourceSetting,
  CatalogProviderId,
  CatalogRelation,
  CatalogSnapshot,
  CatalogSortKey,
  CatalogSourceInput,
  CatalogSourceMetadata,
  CatalogSourcePageState,
  CatalogSourceSummary,
  CatalogStoredSnapshot,
  SessionCatalogPort,
} from '../../application';
import { catalogSourceId, catalogSourceKind, catalogSourceLabel } from '../../application/catalog/catalog-identity';

export const DEFAULT_CATALOG_PAGE_LIMIT = 200 as const;
export const MAX_CATALOG_PAGE_LIMIT = 500 as const;

interface SourceRow {
  source_id: string;
  provider: string;
  label: string;
  root_uri: string;
  generation: number;
  captured_at: string | null;
  fingerprint: string | null;
  update_available: number;
  truncated: number;
  next_cursor: string | null;
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

export class CatalogStore implements SessionCatalogPort {
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
    ensureColumn(db, 'sources', 'truncated', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'sources', 'next_cursor', 'TEXT');
    ensureColumn(db, 'entities', 'title_source', 'TEXT');
    ensureColumn(db, 'entities', 'first_message_preview', 'TEXT');
    ensureColumn(db, 'entities', 'started_at', 'TEXT');
    ensureColumn(db, 'entities', 'activity_at', 'TEXT');
    ensureColumn(db, 'entities', 'relationship', "TEXT NOT NULL DEFAULT 'generic'");
    ensureColumn(db, 'entities', 'project', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS entities_activity_idx ON entities(source_id, generation, activity_at, started_at, native_id);');
    migrateMetadataPlane(db);
    return new CatalogStore(path, db);
  }

  public get path(): string { return this.#path; }

  /**
   * Reconcile the metadata plane without reading source content. A disabled
   * Navigator may still register exact personal files, but it must never turn
   * that registration into an entity scan. The legacy `sources` table remains
   * the compatibility store for the existing tree provider.
   */
  public reconcileSourceMetadata(inputs: readonly CatalogSourceInput[], navigatorEnabled: boolean): void {
    const now = new Date().toISOString();
    const active = new Set(inputs.map((input) => input.sourceId));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.#db.prepare(`INSERT INTO source_registry(
        source_id, provider_id, source_kind, canonical_uri, display_label, config_revision,
        authorization_state, availability_state, metadata_state, entity_scan_state,
        created_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        provider_id = excluded.provider_id, source_kind = excluded.source_kind,
        canonical_uri = excluded.canonical_uri, display_label = excluded.display_label,
        config_revision = excluded.config_revision, authorization_state = excluded.authorization_state,
        availability_state = excluded.availability_state, metadata_state = 'ready',
        entity_scan_state = CASE
          WHEN excluded.entity_scan_state = 'disabled' THEN 'disabled'
          WHEN source_registry.entity_scan_state = 'ready' THEN 'ready'
          ELSE 'pending'
        END, verified_at = excluded.verified_at`);
      for (const input of inputs) {
        upsert.run(
          input.sourceId, input.providerId, input.sourceKind, input.canonicalUri, input.displayLabel,
          input.configRevision, input.authorizationState, input.availabilityState ?? 'unknown',
          navigatorEnabled ? 'pending' : 'disabled', now, now,
        );
        this.#db.prepare(`INSERT INTO index_checkpoint(source_id, plane, scan_epoch, config_revision, state, committed_at)
          VALUES (?, 'metadata', 'config', ?, 'ready', ?)
          ON CONFLICT(source_id, plane, scan_epoch) DO UPDATE SET
            config_revision = excluded.config_revision, state = 'ready', terminal_code = NULL, committed_at = excluded.committed_at`).run(input.sourceId, input.configRevision, now);
        this.#db.prepare(`INSERT INTO index_checkpoint(source_id, plane, scan_epoch, config_revision, state, committed_at)
          VALUES (?, 'entity', 'disabled', ?, ?, ?)
          ON CONFLICT(source_id, plane, scan_epoch) DO UPDATE SET
            config_revision = excluded.config_revision, state = CASE
              WHEN excluded.state = 'disabled' THEN 'disabled'
              WHEN index_checkpoint.state = 'ready' THEN 'ready'
              ELSE 'pending'
            END`).run(input.sourceId, input.configRevision, navigatorEnabled ? 'pending' : 'disabled', now);
      }
      // The effective authorization snapshot is authoritative in either
      // Navigator mode. Disabled only suppresses entity scanning; it must not
      // leave revoked metadata rows discoverable on the next session.
      const rows = this.#db.prepare('SELECT source_id FROM source_registry').all() as Array<{ source_id: string }>;
      const remove = this.#db.prepare('DELETE FROM source_registry WHERE source_id = ?');
      for (const row of rows) if (!active.has(row.source_id)) remove.run(row.source_id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  public listSourceMetadata(): readonly CatalogSourceMetadata[] {
    const rows = this.#db.prepare('SELECT * FROM source_registry ORDER BY display_label COLLATE NOCASE, source_id').all() as unknown as SourceMetadataRow[];
    return rows.map(toSourceMetadata);
  }

  public getSourceMetadata(sourceId: string): CatalogSourceMetadata | undefined {
    const row = this.#db.prepare('SELECT * FROM source_registry WHERE source_id = ?').get(sourceId) as SourceMetadataRow | undefined;
    return row === undefined ? undefined : toSourceMetadata(row);
  }

  public getCheckpoint(sourceId: string, plane: 'metadata' | 'entity'): CatalogCheckpoint | undefined {
    const row = this.#db.prepare('SELECT * FROM index_checkpoint WHERE source_id = ? AND plane = ? ORDER BY committed_at DESC LIMIT 1').get(sourceId, plane) as CheckpointRow | undefined;
    return row === undefined ? undefined : toCheckpoint(row);
  }

  public syncSources(settings: readonly CatalogNavigatorSourceSetting[]): void {
    this.reconcileSourceMetadata(settings.map((setting) => ({
      sourceId: catalogSourceId(setting),
      providerId: setting.provider,
      sourceKind: catalogSourceKind(setting),
      canonicalUri: setting.rootUri,
      displayLabel: catalogSourceLabel(setting),
      configRevision: 'legacy-sync',
      authorizationState: 'authorized',
      availabilityState: 'unknown',
    })), true);
    const active = new Set(settings.map(catalogSourceId));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.#db.prepare(`INSERT INTO sources(source_id, provider, label, root_uri) VALUES (?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET provider = excluded.provider, label = excluded.label, root_uri = excluded.root_uri`);
      for (const setting of settings) {
        upsert.run(catalogSourceId(setting), setting.provider, catalogSourceLabel(setting), setting.rootUri);
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

  public listSources(): readonly CatalogSourceSummary[] {
    const rows = this.#db.prepare('SELECT source_id, provider, label, generation, captured_at, update_available, truncated, next_cursor FROM sources ORDER BY label COLLATE NOCASE').all() as Array<Pick<SourceRow, 'source_id' | 'provider' | 'label' | 'generation' | 'captured_at' | 'update_available' | 'truncated' | 'next_cursor'>>;
    return rows.map((row) => {
      const counts = this.#db.prepare('SELECT (SELECT COUNT(*) FROM entities WHERE source_id = ? AND generation = ?) AS entities, (SELECT COUNT(*) FROM relations WHERE source_id = ? AND generation = ?) AS relations').get(row.source_id, generationText(row.generation), row.source_id, generationText(row.generation)) as { entities: number; relations: number };
      return {
        sourceId: row.source_id,
        provider: row.provider as CatalogProviderId,
        label: row.label,
        generation: generationText(row.generation),
        ...(row.captured_at === null ? {} : { capturedAt: row.captured_at }),
        entityCount: Number(counts.entities ?? 0),
        relationCount: Number(counts.relations ?? 0),
        updateAvailable: row.update_available === 1,
        truncated: row.truncated === 1,
        ...(row.next_cursor === null ? {} : { nextCursor: row.next_cursor }),
        ...lastActivityFor(this.#db, row.source_id, generationText(row.generation)),
      };
    });
  }

  public getSourceRoot(sourceId: string): string | undefined {
    const row = this.#db.prepare('SELECT root_uri FROM sources WHERE source_id = ?').get(sourceId) as { root_uri?: string } | undefined;
    return row?.root_uri;
  }

  public getSourceProvider(sourceId: string): CatalogProviderId | undefined {
    const row = this.#db.prepare('SELECT provider FROM sources WHERE source_id = ?').get(sourceId) as { provider?: string } | undefined;
    return row?.provider as CatalogProviderId | undefined;
  }

  public getFingerprint(sourceId: string): string | undefined {
    const row = this.#db.prepare('SELECT fingerprint FROM sources WHERE source_id = ?').get(sourceId) as { fingerprint?: string | null } | undefined;
    return row?.fingerprint ?? undefined;
  }

  public getSourcePageState(sourceId: string): CatalogSourcePageState | undefined {
    const source = this.#sourceRow(sourceId);
    if (source === undefined) return undefined;
    return {
      generation: generationText(source.generation),
      ...(source.next_cursor === null ? {} : { nextCursor: source.next_cursor }),
      ...(source.fingerprint === null ? {} : { fingerprint: source.fingerprint }),
    };
  }

  public getChildren(sourceId: string, parentNativeId?: string, sortKey: CatalogSortKey = 'activity'): readonly CatalogEntity[] {
    return this.getChildrenPage(sourceId, parentNativeId, sortKey).entities;
  }

  public getChildrenPage(sourceId: string, parentNativeId?: string, sortKey: CatalogSortKey = 'activity', options: CatalogChildrenPageOptions = {}): CatalogChildrenPage {
    const source = this.#sourceRow(sourceId);
    if (source === undefined || source.generation < 1) return { entities: [], generation: source === undefined ? generationText(0) : generationText(source.generation) };
    throwIfAborted(options.signal);
    const generation = generationText(source.generation);
    const limit = boundedLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeChildrenCursor(options.cursor);
    if (cursor !== undefined && (cursor.sourceId !== sourceId || cursor.generation !== generation || cursor.parentNativeId !== (parentNativeId ?? null) || cursor.sortKey !== sortKey)) {
      throw new Error('Catalog children cursor is stale.');
    }
    const orderBy = orderByFor(sortKey);
    const sortExpression = sortExpressionFor(sortKey);
    const where = ['e.source_id = ?', 'e.generation = ?'];
    const parameters: SQLInputValue[] = [sourceId, generation];
    if (parentNativeId === undefined) {
      where.push('e.parent_native_id IS NULL');
    } else {
      where.push('e.parent_native_id = ?');
      parameters.push(parentNativeId);
    }
    if (cursor !== undefined) {
      const comparator = sortKey === 'title' ? '>' : '<';
      where.push(`(${sortExpression} ${comparator} ? OR (${sortExpression} = ? AND e.native_id > ?))`);
      parameters.push(cursor.lastValue, cursor.lastValue, cursor.nativeId);
    }
    const query = `SELECT e.*, l.product_title FROM entities e LEFT JOIN entity_labels l ON l.source_id = e.source_id AND l.native_id = e.native_id WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`;
    parameters.push(limit + 1);
    const rows = this.#db.prepare(query).all(...parameters) as unknown as EntityRow[];
    throwIfAborted(options.signal);
    const pageRows = rows.slice(0, limit);
    const entities = pageRows.map((row) => toEntity(row, source.provider as CatalogProviderId));
    const last = pageRows.at(-1);
    const hasMore = rows.length > limit && last !== undefined;
    return {
      entities,
      generation,
      ...(hasMore && last !== undefined ? { nextCursor: encodeChildrenCursor({ sourceId, generation, parentNativeId: parentNativeId ?? null, sortKey, lastValue: sortValueFor(last, sortKey), nativeId: last.native_id }) } : {}),
    };
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

  public getLocation(intent: { sourceId: string; generation: string; nativeId: string }): CatalogLocation | undefined {
    const row = this.#db.prepare('SELECT native_id, relative_path, row_ordinal FROM locations WHERE source_id = ? AND generation = ? AND native_id = ?').get(intent.sourceId, intent.generation, intent.nativeId) as LocationRow | undefined;
    if (row === undefined) return undefined;
    return { nativeId: row.native_id, relativePath: row.relative_path, rowOrdinal: row.row_ordinal };
  }

  public getSnapshot(sourceId: string): CatalogStoredSnapshot | undefined {
    const source = this.#sourceRow(sourceId);
    if (source === undefined || source.generation < 1) return undefined;
    const generation = generationText(source.generation);
    const entities = (this.#db.prepare('SELECT e.*, l.product_title FROM entities e LEFT JOIN entity_labels l ON l.source_id = e.source_id AND l.native_id = e.native_id WHERE e.source_id = ? AND e.generation = ?').all(sourceId, generation) as unknown as EntityRow[]).map((row) => toEntity(row, source.provider as CatalogProviderId));
    const relations = this.#db.prepare('SELECT source_id, from_native_id, to_native_id, kind FROM relations WHERE source_id = ? AND generation = ?').all(sourceId, generation) as unknown as RelationRow[];
    const locations = this.#db.prepare('SELECT native_id, relative_path, row_ordinal FROM locations WHERE source_id = ? AND generation = ?').all(sourceId, generation) as unknown as LocationRow[];
    return { schemaVersion: 1, provider: source.provider as CatalogProviderId, sourceId, sourceGeneration: generation, snapshotId: 'catalog-' + sourceId + '-' + generation, capturedAt: source.captured_at ?? new Date(0).toISOString(), redaction: 'metadata-only', entities, relations: relations.map((row) => ({ sourceId: row.source_id, fromNativeId: row.from_native_id, toNativeId: row.to_native_id, kind: row.kind as CatalogRelation['kind'] })), locations: locations.map((row) => ({ nativeId: row.native_id, relativePath: row.relative_path, rowOrdinal: row.row_ordinal })), truncated: source.truncated === 1, ...(source.next_cursor === null ? {} : { nextCursor: source.next_cursor }) };
  }

  public appendSnapshot(sourceId: string, page: CatalogSnapshot, fingerprint: string, guard?: CatalogAppendGuard): CatalogStoredSnapshot {
    const source = this.#sourceRow(sourceId);
    if (source === undefined) throw new Error('Navigation source is not configured.');
    assertAppendGuard(source, fingerprint, guard);
    if (source.generation < 1) return this.replaceSnapshot(sourceId, page, fingerprint);

    const previousGeneration = generationText(source.generation);
    const nextGenerationNumber = source.generation + 1;
    const generation = generationText(nextGenerationNumber);
    const insertEntity = this.#db.prepare(`INSERT INTO entities(
      source_id, generation, native_id, kind, label, parent_native_id, updated_at, status, confidence, opaque_ref,
      vendor_title, title_source, first_message_preview, started_at, activity_at, relationship, project
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const deleteEntity = this.#db.prepare('DELETE FROM entities WHERE source_id = ? AND generation = ? AND native_id = ?');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      assertAppendGuard(this.#sourceRow(sourceId), fingerprint, guard);
      // Copy the prior generation inside SQLite. This avoids materializing the
      // entire catalog in JS for every continuation page.
      this.#db.prepare(`INSERT INTO entities(
        source_id, generation, native_id, kind, label, parent_native_id, updated_at, status, confidence, opaque_ref,
        vendor_title, title_source, first_message_preview, started_at, activity_at, relationship, project
      ) SELECT source_id, ?, native_id, kind, label, parent_native_id, updated_at, status, confidence, opaque_ref,
        vendor_title, title_source, first_message_preview, started_at, activity_at, relationship, project
        FROM entities WHERE source_id = ? AND generation = ?`).run(generation, sourceId, previousGeneration);
      this.#db.prepare(`INSERT INTO relations(source_id, generation, from_native_id, to_native_id, kind)
        SELECT source_id, ?, from_native_id, to_native_id, kind
        FROM relations WHERE source_id = ? AND generation = ?`).run(generation, sourceId, previousGeneration);
      this.#db.prepare(`INSERT INTO locations(source_id, generation, native_id, relative_path, row_ordinal)
        SELECT source_id, ?, native_id, relative_path, row_ordinal
        FROM locations WHERE source_id = ? AND generation = ?`).run(generation, sourceId, previousGeneration);

      for (const entity of page.entities) {
        deleteEntity.run(sourceId, generation, entity.nativeId);
        insertEntity.run(
          sourceId, generation, entity.nativeId, entity.kind, entity.label, entity.parentNativeId ?? null, entity.updatedAt ?? null,
          entity.status ?? null, entity.confidence, entity.opaqueRef ?? null, entity.vendorTitle ?? null, entity.titleSource ?? null,
          entity.firstMessagePreview ?? null, entity.startedAt ?? null, entity.activityAt ?? entity.updatedAt ?? null,
          entity.relationship ?? 'generic', entity.project ?? null,
        );
      }
      const insertRelation = this.#db.prepare('INSERT OR IGNORE INTO relations(source_id, generation, from_native_id, to_native_id, kind) VALUES (?, ?, ?, ?, ?)');
      for (const relation of page.relations) insertRelation.run(sourceId, generation, relation.fromNativeId, relation.toNativeId, relation.kind);
      const insertLocation = this.#db.prepare('INSERT OR REPLACE INTO locations(source_id, generation, native_id, relative_path, row_ordinal) VALUES (?, ?, ?, ?, ?)');
      for (const location of page.locations) insertLocation.run(sourceId, generation, location.nativeId, location.relativePath, location.rowOrdinal);

      // A continuation may introduce a parent after its child. Reconcile only
      // rows in the new generation; existing rows remain untouched until the
      // generation switch is committed.
      this.#db.prepare(`UPDATE entities AS child
        SET parent_native_id = (SELECT relation.to_native_id FROM relations AS relation
          JOIN entities AS parent ON parent.source_id = relation.source_id
            AND parent.generation = relation.generation AND parent.native_id = relation.to_native_id
          WHERE relation.source_id = child.source_id AND relation.generation = child.generation
            AND relation.from_native_id = child.native_id AND relation.kind = 'parent'
          LIMIT 1),
          relationship = 'subagent'
        WHERE child.source_id = ? AND child.generation = ?
          AND EXISTS (SELECT 1 FROM relations AS relation
            JOIN entities AS parent ON parent.source_id = relation.source_id
              AND parent.generation = relation.generation AND parent.native_id = relation.to_native_id
            WHERE relation.source_id = child.source_id AND relation.generation = child.generation
              AND relation.from_native_id = child.native_id AND relation.kind = 'parent')`).run(sourceId, generation);

      this.#db.prepare('DELETE FROM entities WHERE source_id = ? AND generation = ?').run(sourceId, previousGeneration);
      this.#db.prepare('DELETE FROM relations WHERE source_id = ? AND generation = ?').run(sourceId, previousGeneration);
      this.#db.prepare('DELETE FROM locations WHERE source_id = ? AND generation = ?').run(sourceId, previousGeneration);
      this.#db.prepare('UPDATE sources SET generation = ?, captured_at = ?, fingerprint = ?, update_available = 0, truncated = ?, next_cursor = ? WHERE source_id = ?').run(
        nextGenerationNumber, page.capturedAt, fingerprint, page.truncated ? 1 : 0, page.nextCursor ?? null, sourceId,
      );
      this.#db.prepare(`UPDATE source_registry SET fingerprint = ?, entity_scan_state = 'ready', verified_at = ?, error_code = NULL WHERE source_id = ?`).run(fingerprint, page.capturedAt, sourceId);
      this.#db.prepare(`INSERT INTO index_checkpoint(source_id, plane, scan_epoch, config_revision, state, fingerprint, committed_at)
        SELECT source_id, 'entity', ?, config_revision, 'ready', ?, ? FROM source_registry WHERE source_id = ?
        ON CONFLICT(source_id, plane, scan_epoch) DO UPDATE SET state = 'ready', fingerprint = excluded.fingerprint, terminal_code = NULL, committed_at = excluded.committed_at`).run(generation, fingerprint, page.capturedAt, sourceId);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    const committed = this.getSnapshot(sourceId);
    if (committed === undefined) throw new Error('Catalog append committed without a readable snapshot.');
    return Object.freeze({ ...committed, snapshotId: snapshotId(sourceId, generation, committed), locations: Object.freeze(committed.locations.map((location) => Object.freeze({ ...location }))) });
  }

  public replaceSnapshot(sourceId: string, snapshot: CatalogSnapshot, fingerprint: string): CatalogStoredSnapshot {
    const source = this.#sourceRow(sourceId);
    if (source === undefined) throw new Error('Navigation source is not configured.');
    const nextGeneration = source.generation + 1;
    const generation = generationText(nextGeneration);
    const nextSnapshot: CatalogStoredSnapshot = Object.freeze({
      ...snapshot,
      sourceGeneration: generation,
      snapshotId: snapshotId(sourceId, generation, snapshot),
      entities: Object.freeze(snapshot.entities.map((entity) => Object.freeze({ ...entity, generation, provider: snapshot.provider }))),
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
      this.#db.prepare('UPDATE sources SET generation = ?, captured_at = ?, fingerprint = ?, update_available = 0, truncated = ?, next_cursor = ? WHERE source_id = ?').run(nextGeneration, nextSnapshot.capturedAt, fingerprint, nextSnapshot.truncated ? 1 : 0, nextSnapshot.nextCursor ?? null, sourceId);
      this.#db.prepare(`UPDATE source_registry SET fingerprint = ?, entity_scan_state = 'ready', verified_at = ?, error_code = NULL WHERE source_id = ?`).run(fingerprint, nextSnapshot.capturedAt, sourceId);
      this.#db.prepare(`INSERT INTO index_checkpoint(source_id, plane, scan_epoch, config_revision, state, fingerprint, committed_at)
        SELECT source_id, 'entity', ?, config_revision, 'ready', ?, ? FROM source_registry WHERE source_id = ?
        ON CONFLICT(source_id, plane, scan_epoch) DO UPDATE SET state = 'ready', fingerprint = excluded.fingerprint, terminal_code = NULL, committed_at = excluded.committed_at`).run(generation, fingerprint, nextSnapshot.capturedAt, sourceId);
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

  public invalidateContinuationIfCurrent(sourceId: string, expected: CatalogContinuationExpectation): boolean {
    const generation = generationNumber(expected.generation);
    if (generation === undefined) return false;
    const result = this.#db.prepare('UPDATE sources SET next_cursor = NULL WHERE source_id = ? AND generation = ? AND next_cursor = ? AND fingerprint = ?')
      .run(sourceId, generation, expected.cursor, expected.fingerprint);
    return Number(result.changes) === 1;
  }

  public close(): void { this.#db.close(); }

  #sourceRow(sourceId: string): SourceRow | undefined {
    return this.#db.prepare('SELECT * FROM sources WHERE source_id = ?').get(sourceId) as SourceRow | undefined;
  }
}

function generationText(value: number | string): string { return `g-${String(value)}`; }

function generationNumber(value: string): number | undefined {
  const match = /^g-(0|[1-9]\d*)$/u.exec(value);
  if (match === null) return undefined;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

interface ChildrenCursor {
  readonly sourceId: string;
  readonly generation: string;
  readonly parentNativeId: string | null;
  readonly sortKey: CatalogSortKey;
  readonly lastValue: string;
  readonly nativeId: string;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CATALOG_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_CATALOG_PAGE_LIMIT, Math.floor(value)));
}

function sortExpressionFor(sortKey: CatalogSortKey): string {
  switch (sortKey) {
    case 'created':
      return "COALESCE(e.started_at, e.updated_at, '')";
    case 'title':
      return "COALESCE(l.product_title, e.vendor_title, e.label) COLLATE NOCASE";
    case 'activity':
    default:
      return "COALESCE(e.activity_at, e.updated_at, e.started_at, '')";
  }
}

function sortValueFor(row: EntityRow, sortKey: CatalogSortKey): string {
  switch (sortKey) {
    case 'created':
      return row.started_at ?? row.updated_at ?? '';
    case 'title':
      // Keep the original title. SQLite applies its NOCASE collation to both
      // the ORDER BY expression and the keyset predicate; applying JavaScript
      // locale folding here can disagree for non-ASCII titles (for example Ä/Ö)
      // and skip or repeat a row at a page boundary.
      return row.product_title ?? row.vendor_title ?? row.label;
    case 'activity':
    default:
      return row.activity_at ?? row.updated_at ?? row.started_at ?? '';
  }
}

function encodeChildrenCursor(cursor: ChildrenCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

function decodeChildrenCursor(value: string): ChildrenCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ChildrenCursor> & { v?: number };
    if (parsed.v !== 1 || typeof parsed.sourceId !== 'string' || typeof parsed.generation !== 'string' || (typeof parsed.parentNativeId !== 'string' && parsed.parentNativeId !== null) || (parsed.sortKey !== 'activity' && parsed.sortKey !== 'created' && parsed.sortKey !== 'title') || typeof parsed.lastValue !== 'string' || typeof parsed.nativeId !== 'string') throw new Error('invalid');
    return parsed as ChildrenCursor;
  } catch {
    throw new Error('Catalog children cursor is invalid.');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Catalog page read cancelled.');
}

function assertAppendGuard(source: SourceRow | undefined, fingerprint: string, guard: CatalogAppendGuard | undefined): void {
  if (guard?.signal?.aborted) throw new Error('Catalog page commit cancelled.');
  if (guard === undefined) return;
  if (source === undefined || generationText(source.generation) !== guard.expectedGeneration || source.next_cursor !== guard.expectedCursor || (guard.expectedFingerprint !== undefined && source.fingerprint !== guard.expectedFingerprint) || source.fingerprint !== fingerprint) {
    throw new Error('Catalog page is stale.');
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function orderByFor(sortKey: CatalogSortKey): string {
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

function toEntity(row: EntityRow, provider: CatalogProviderId): CatalogEntity {
  const productTitle = row.product_title ?? undefined;
  const vendorTitle = row.vendor_title ?? undefined;
  const firstMessagePreview = row.first_message_preview ?? undefined;
  const label = productTitle ?? vendorTitle ?? firstMessagePreview ?? row.label;
  return {
    sourceId: row.source_id,
    nativeId: row.native_id,
    kind: row.kind as CatalogEntity['kind'],
    label,
    ...(vendorTitle === undefined ? {} : { vendorTitle }),
    ...(productTitle === undefined ? {} : { productTitle }),
    ...(row.title_source === null ? {} : { titleSource: row.title_source as NonNullable<CatalogEntity['titleSource']> }),
    ...(firstMessagePreview === undefined ? {} : { firstMessagePreview }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.activity_at === null ? {} : { activityAt: row.activity_at }),
    ...(row.relationship === null ? {} : { relationship: row.relationship as NonNullable<CatalogEntity['relationship']> }),
    ...(row.project === null ? {} : { project: row.project }),
    confidence: row.confidence as CatalogEntity['confidence'],
    generation: row.generation,
    provider,
    ...(row.parent_native_id === null ? {} : { parentNativeId: row.parent_native_id }),
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.opaque_ref === null ? {} : { opaqueRef: row.opaque_ref }),
  };
}

function snapshotId(sourceId: string, generation: string, snapshot: CatalogSnapshot): string {
  return `catalog-${createHash('sha256').update(JSON.stringify({ sourceId, generation, capturedAt: snapshot.capturedAt, entities: snapshot.entities.length, relations: snapshot.relations.length }), 'utf8').digest('hex').slice(0, 32)}`;
}

interface SourceMetadataRow {
  source_id: string;
  provider_id: string;
  source_kind: CatalogSourceMetadata['sourceKind'];
  canonical_uri: string;
  display_label: string;
  config_revision: string;
  authorization_state: CatalogSourceMetadata['authorizationState'];
  availability_state: CatalogSourceMetadata['availabilityState'];
  metadata_state: CatalogSourceMetadata['metadataState'];
  entity_scan_state: CatalogSourceMetadata['entityScanState'];
  fingerprint: string | null;
  size_bytes: string | null;
  modified_at: string | null;
  created_at: string;
  verified_at: string | null;
  error_code: string | null;
}

interface CheckpointRow {
  source_id: string;
  plane: CatalogCheckpoint['plane'];
  scan_epoch: string;
  config_revision: string;
  state: CatalogCheckpoint['state'];
  cursor: string | null;
  fingerprint: string | null;
  terminal_code: string | null;
  committed_at: string | null;
}

function toSourceMetadata(row: SourceMetadataRow): CatalogSourceMetadata {
  return {
    sourceId: row.source_id, providerId: row.provider_id, sourceKind: row.source_kind, canonicalUri: row.canonical_uri,
    displayLabel: row.display_label, configRevision: row.config_revision, authorizationState: row.authorization_state,
    availabilityState: row.availability_state, metadataState: row.metadata_state, entityScanState: row.entity_scan_state,
    ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
    ...(row.modified_at === null ? {} : { modifiedAt: row.modified_at }),
    createdAt: row.created_at, ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

function toCheckpoint(row: CheckpointRow): CatalogCheckpoint {
  return {
    sourceId: row.source_id, plane: row.plane, scanEpoch: row.scan_epoch, configRevision: row.config_revision, state: row.state,
    ...(row.cursor === null ? {} : { cursor: row.cursor }), ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    ...(row.terminal_code === null ? {} : { terminalCode: row.terminal_code }),
    ...(row.committed_at === null ? {} : { committedAt: row.committed_at }),
  };
}

/** Additive migration: legacy tables stay intact until the catalog adapter is promoted. */
function migrateMetadataPlane(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_registry (
      source_id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('provider_home','folder','exact_file')),
      canonical_uri TEXT NOT NULL,
      display_label TEXT NOT NULL,
      config_revision TEXT NOT NULL,
      authorization_state TEXT NOT NULL CHECK (authorization_state IN ('authorized','revoked','unknown')),
      availability_state TEXT NOT NULL CHECK (availability_state IN ('available','missing','unknown')),
      metadata_state TEXT NOT NULL CHECK (metadata_state IN ('pending','ready','stale','failed')),
      entity_scan_state TEXT NOT NULL CHECK (entity_scan_state IN ('disabled','pending','ready','stale','failed')),
      fingerprint TEXT,
      size_bytes TEXT,
      modified_at TEXT,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      error_code TEXT,
      UNIQUE (provider_id, canonical_uri)
    );
    CREATE TABLE IF NOT EXISTS index_checkpoint (
      source_id TEXT NOT NULL REFERENCES source_registry(source_id) ON DELETE CASCADE,
      plane TEXT NOT NULL CHECK (plane IN ('metadata','entity')),
      scan_epoch TEXT NOT NULL,
      config_revision TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','ready','stale','failed','disabled')),
      cursor TEXT,
      fingerprint TEXT,
      terminal_code TEXT,
      committed_at TEXT,
      PRIMARY KEY (source_id, plane, scan_epoch)
    );
    CREATE INDEX IF NOT EXISTS source_registry_label_idx ON source_registry(display_label COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS checkpoint_recent_idx ON index_checkpoint(source_id, plane, committed_at DESC);
    INSERT OR IGNORE INTO source_registry(
      source_id, provider_id, source_kind, canonical_uri, display_label, config_revision,
      authorization_state, availability_state, metadata_state, entity_scan_state,
      fingerprint, created_at, verified_at
    ) SELECT source_id, provider,
      CASE WHEN lower(root_uri) LIKE '%.jsonl' OR lower(root_uri) LIKE '%.ndjson' THEN 'exact_file'
        WHEN provider = 'generic' THEN 'folder' ELSE 'provider_home' END,
      root_uri, label, 'legacy-sync', 'authorized', 'unknown', 'ready',
      CASE WHEN generation > 0 THEN 'ready' ELSE 'disabled' END, fingerprint,
      COALESCE(captured_at, '1970-01-01T00:00:00.000Z'), captured_at
      FROM sources;
    INSERT OR IGNORE INTO index_checkpoint(source_id, plane, scan_epoch, config_revision, state, fingerprint, committed_at)
      SELECT source_id, 'metadata', 'config', config_revision, 'ready', fingerprint, verified_at FROM source_registry;
    INSERT OR IGNORE INTO index_checkpoint(source_id, plane, scan_epoch, config_revision, state, fingerprint, committed_at)
      SELECT source_id, 'entity', CASE WHEN entity_scan_state = 'ready' THEN 'legacy' ELSE 'disabled' END,
        config_revision, entity_scan_state, fingerprint, verified_at FROM source_registry;
    INSERT INTO catalog_meta(key, value) VALUES ('schema_version', '3')
      ON CONFLICT(key) DO UPDATE SET value = CASE WHEN CAST(catalog_meta.value AS INTEGER) < 3 THEN '3' ELSE catalog_meta.value END;
  `);
}
