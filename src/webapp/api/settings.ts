// src/webapp/api/settings.ts
import { Router } from 'express';
import { getDb } from '../../db/index.js';

export function settingsApi(): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    const rows = getDb()
      .prepare('SELECT key, value_json FROM settings')
      .all() as Array<{ key: string; value_json: string }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = JSON.parse(row.value_json);
    res.json(out);
  });

  r.put('/:key', (req, res) => {
    const value = req.body;
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)`,
      )
      .run(req.params.key, JSON.stringify(value), Date.now());
    res.json({ updated: req.params.key });
  });

  return r;
}
