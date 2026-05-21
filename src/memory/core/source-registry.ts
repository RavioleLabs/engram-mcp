import { ulid } from 'ulid';
import { getDb } from '../../db/index.js';

export interface WatchedSource {
  id: string;
  module_id: string;
  external_id: string;
  display_name: string;
  config: Record<string, unknown>;
  last_synced_at: number | null;
  last_modified_remote: string | null;
  last_error: string | null;
  enabled: boolean;
  created_at: number;
}

export interface AddSourceInput {
  module_id: string;
  external_id: string;
  display_name: string;
  config?: Record<string, unknown>;
}

function rowToSource(row: Record<string, unknown>): WatchedSource {
  return {
    id: row.id as string,
    module_id: row.module_id as string,
    external_id: row.external_id as string,
    display_name: row.display_name as string,
    config: JSON.parse((row.config_json as string) || '{}'),
    last_synced_at: (row.last_synced_at as number | null) ?? null,
    last_modified_remote: (row.last_modified_remote as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    enabled: !!row.enabled,
    created_at: row.created_at as number,
  };
}

class SourceRegistry {
  /**
   * Add a watched source.
   * IDEMPOTENT: if (module_id, external_id) already exists, returns the existing id
   * without inserting a duplicate row. Callers can check `alreadyExists` on the result.
   */
  add(input: AddSourceInput): string {
    const existing = getDb()
      .prepare(
        `SELECT id FROM watched_sources WHERE module_id = ? AND external_id = ? LIMIT 1`,
      )
      .get(input.module_id, input.external_id) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = ulid();
    getDb()
      .prepare(
        `INSERT INTO watched_sources
         (id, module_id, external_id, display_name, config_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        input.module_id,
        input.external_id,
        input.display_name,
        JSON.stringify(input.config ?? {}),
        Date.now(),
      );
    return id;
  }

  /**
   * Like add(), but also signals whether the source already existed.
   */
  addWithStatus(input: AddSourceInput): { id: string; alreadyExists: boolean } {
    const existing = getDb()
      .prepare(
        `SELECT id FROM watched_sources WHERE module_id = ? AND external_id = ? LIMIT 1`,
      )
      .get(input.module_id, input.external_id) as { id: string } | undefined;
    if (existing) return { id: existing.id, alreadyExists: true };
    const id = this.add(input);
    return { id, alreadyExists: false };
  }

  get(id: string): WatchedSource | undefined {
    const row = getDb().prepare('SELECT * FROM watched_sources WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSource(row) : undefined;
  }

  list(module_id?: string): WatchedSource[] {
    const rows = module_id
      ? (getDb()
          .prepare('SELECT * FROM watched_sources WHERE module_id = ? ORDER BY created_at')
          .all(module_id) as Array<Record<string, unknown>>)
      : (getDb()
          .prepare('SELECT * FROM watched_sources ORDER BY module_id, created_at')
          .all() as Array<Record<string, unknown>>);
    return rows.map(rowToSource);
  }

  listEnabled(module_id: string): WatchedSource[] {
    const rows = getDb()
      .prepare(
        'SELECT * FROM watched_sources WHERE module_id = ? AND enabled = 1 ORDER BY created_at',
      )
      .all(module_id) as Array<Record<string, unknown>>;
    return rows.map(rowToSource);
  }

  recordSync(id: string, remoteModifiedAt: string | null = null, error?: string): void {
    getDb()
      .prepare(
        `UPDATE watched_sources
         SET last_synced_at = ?, last_modified_remote = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(Date.now(), remoteModifiedAt, error ?? null, id);
  }

  setEnabled(id: string, enabled: boolean): void {
    getDb()
      .prepare('UPDATE watched_sources SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id);
  }

  remove(id: string): void {
    getDb().prepare('DELETE FROM watched_sources WHERE id = ?').run(id);
  }
}

export const sourceRegistry = new SourceRegistry();
