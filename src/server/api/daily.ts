// src/webapp/api/daily.ts
import { Router } from 'express';
import { getDb } from '../../db/index.js';

export function dailyApi(): Router {
  const r = Router();

  // Returns counts grouped by day for the last N days
  r.get('/buckets', (req, res) => {
    const days = Math.min(365, Number(req.query.days ?? 30));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = getDb()
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
           type,
           COUNT(*) AS count
         FROM memories WHERE created_at >= ?
         GROUP BY day, type
         ORDER BY day DESC, type`,
      )
      .all(since) as Array<{ day: string; type: string; count: number }>;
    res.json(rows);
  });

  // Returns memories created on a specific day (YYYY-MM-DD), optionally filtered by type
  r.get('/items/:day', (req, res) => {
    const day = req.params.day;
    const type = req.query.type as string | undefined;
    const startOfDay = Date.parse(`${day}T00:00:00Z`);
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
    const query = type
      ? `SELECT id, type, source_id, properties_json, created_at FROM memories
         WHERE created_at >= ? AND created_at < ? AND type = ? ORDER BY created_at DESC`
      : `SELECT id, type, source_id, properties_json, created_at FROM memories
         WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC`;
    const params = type ? [startOfDay, endOfDay, type] : [startOfDay, endOfDay];
    const rows = getDb().prepare(query).all(...params) as Array<Record<string, unknown>>;
    res.json(
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        source_id: row.source_id,
        properties: JSON.parse(row.properties_json as string),
        created_at: row.created_at,
      })),
    );
  });

  return r;
}
