import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CollectionsError, type CollectionsMutationCommand } from '@application/index';

export const COLLECTIONS_PENDING_CAPACITY = 64;
interface PendingRow { request_id: string | null; command_hash: string; command_json: string | null }

/** SQL operations run only inside the store's explicit read/writer transaction. */
export class CollectionsCommandJournal {
  private readonly db: DatabaseSync;
  private readonly validate: (command: CollectionsMutationCommand) => void;
  public constructor(db: DatabaseSync, validate: (command: CollectionsMutationCommand) => void) { this.db = db; this.validate = validate; }

  public list(): readonly CollectionsMutationCommand[] {
    // Bound damaged TEXT inside SQLite before transferring it into JavaScript.
    const rows = this.db.prepare(`SELECT
      CASE WHEN length(CAST(request_id AS BLOB)) = 36 THEN request_id ELSE NULL END AS request_id,
      command_hash,
      CASE WHEN length(CAST(command_json AS BLOB)) <= 32768 THEN command_json ELSE NULL END AS command_json
      FROM collections_pending_command ORDER BY request_id LIMIT ?`).all(COLLECTIONS_PENDING_CAPACITY + 1) as unknown as PendingRow[];
    if (rows.length > COLLECTIONS_PENDING_CAPACITY) throw new CollectionsError('METADATA_UNAVAILABLE');
    try {
      return rows.map((row) => {
        if (typeof row.command_json !== 'string' || Buffer.byteLength(row.command_json, 'utf8') > 32_768) throw new Error();
        const command = JSON.parse(row.command_json) as CollectionsMutationCommand;
        this.validate(command);
        if (command.requestId !== row.request_id || collectionsCommandHash(command) !== row.command_hash) throw new Error();
        return command;
      });
    } catch { throw new CollectionsError('METADATA_UNAVAILABLE'); }
  }

  public accept(commands: readonly CollectionsMutationCommand[]): void {
    // Validate all current and imported records before writing any of them.
    if (commands.length > COLLECTIONS_PENDING_CAPACITY) throw new CollectionsError('METADATA_UNAVAILABLE');
    this.list();
    for (const command of commands) this.validate(command);
    for (const command of commands) {
      const hash = collectionsCommandHash(command);
      const receipt = this.db.prepare('SELECT command_hash FROM collections_mutation_receipt WHERE request_id = ?').get(command.requestId);
      const prior = this.db.prepare('SELECT command_hash FROM collections_pending_command WHERE request_id = ?').get(command.requestId);
      if ((receipt !== undefined && receipt.command_hash !== hash) || (prior !== undefined && prior.command_hash !== hash)) throw new CollectionsError('MUTATION_CONFLICT');
      if (receipt !== undefined || prior !== undefined) continue;
      const count = this.db.prepare('SELECT count(*) AS count FROM collections_pending_command').get()?.count;
      if (typeof count !== 'number' || count >= COLLECTIONS_PENDING_CAPACITY) throw new CollectionsError('METADATA_UNAVAILABLE');
      this.db.prepare('INSERT INTO collections_pending_command VALUES (?, ?, ?)').run(command.requestId, hash, JSON.stringify(command));
    }
  }

  public complete(command: CollectionsMutationCommand): void {
    this.validate(command);
    const hash = collectionsCommandHash(command);
    const receipt = this.db.prepare('SELECT command_hash FROM collections_mutation_receipt WHERE request_id = ?').get(command.requestId);
    if (receipt === undefined || receipt.command_hash !== hash) throw new CollectionsError('MUTATION_CONFLICT');
    const prior = this.db.prepare('SELECT command_hash FROM collections_pending_command WHERE request_id = ?').get(command.requestId);
    if (prior !== undefined && prior.command_hash !== hash) throw new CollectionsError('MUTATION_CONFLICT');
    this.db.prepare('DELETE FROM collections_pending_command WHERE request_id = ? AND command_hash = ?').run(command.requestId, hash);
  }
}

export function collectionsCommandHash(command: CollectionsMutationCommand): string {
  const canonical = JSON.stringify({ action: command.action, expectedRevision: command.expectedRevision, payload: canonicalValue(command.payload) });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}
