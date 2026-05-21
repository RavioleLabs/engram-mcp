// src/webapp/api/views.ts
import { Router } from 'express';
import { ulid } from 'ulid';
import { getDb } from '../../db/index.js';

export interface SavedView {
  id: string;
  name: string;
  description: string | null;
  definition: {
    filters?: Array<{ field: string; op: string; value: unknown }>;
    sort?: { field: string; direction: 'asc' | 'desc' };
    group_by?: string;
    layout?: 'table' | 'gallery' | 'list';
    types?: string[];
  };
  pinned: boolean;
  created_at: number;
  updated_at: number;
}

export function viewsApi(): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    const rows = getDb()
      .prepare(`SELECT * FROM saved_views ORDER BY pinned DESC, updated_at DESC`)
      .all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        definition: JSON.parse(row.definition_json as string),
        pinned: !!row.pinned,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    );
  });

  r.post('/', (req, res) => {
    const body = req.body as Partial<SavedView>;
    if (!body.name || !body.definition) {
      res.status(400).json({ error: 'name and definition required' });
      return;
    }
    const id = ulid();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO saved_views
         (id, name, description, definition_json, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        body.name,
        body.description ?? null,
        JSON.stringify(body.definition),
        body.pinned ? 1 : 0,
        now,
        now,
      );
    res.json({ id });
  });

  r.put('/:id', (req, res) => {
    const body = req.body as Partial<SavedView>;
    getDb()
      .prepare(
        `UPDATE saved_views SET name = COALESCE(?, name),
                                description = COALESCE(?, description),
                                definition_json = COALESCE(?, definition_json),
                                pinned = COALESCE(?, pinned),
                                updated_at = ?
         WHERE id = ?`,
      )
      .run(
        body.name ?? null,
        body.description ?? null,
        body.definition ? JSON.stringify(body.definition) : null,
        body.pinned !== undefined ? (body.pinned ? 1 : 0) : null,
        Date.now(),
        req.params.id,
      );
    res.json({ updated: req.params.id });
  });

  r.delete('/:id', (req, res) => {
    getDb().prepare('DELETE FROM saved_views WHERE id = ?').run(req.params.id);
    res.json({ deleted: req.params.id });
  });

  return r;
}
