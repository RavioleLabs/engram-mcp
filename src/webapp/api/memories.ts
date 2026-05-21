// src/webapp/api/memories.ts
import type { Router } from 'express';
import { Router as router } from 'express';
import { getDb } from '../../db/index.js';
import type { MemoryStore } from '../../memory/core/store.js';

export function memoriesApi(store: MemoryStore): Router {
  const r = router();
  r.get('/', (req, res) => {
    const limit = Math.min(200, Number(req.query.limit ?? 50));
    const type = req.query.type as string | undefined;
    const rows = type
      ? (getDb()
          .prepare(
            `SELECT id, type, source_id, content, properties_json, created_at
             FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(type, limit) as Array<Record<string, unknown>>)
      : (getDb()
          .prepare(
            `SELECT id, type, source_id, content, properties_json, created_at
             FROM memories ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit) as Array<Record<string, unknown>>);
    res.json(
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        source_id: row.source_id,
        content_preview: (row.content as string).slice(0, 300),
        properties: JSON.parse(row.properties_json as string),
        created_at: row.created_at,
      })),
    );
  });

  r.get('/search', async (req, res) => {
    const q = (req.query.q as string) ?? '';
    const type = req.query.type as string | undefined;
    const limit = Math.min(50, Number(req.query.limit ?? 10));
    if (!q) {
      res.json([]);
      return;
    }
    try {
      let hits;
      if (type) {
        hits = await store.search(type, q, limit);
      } else {
        const types = store.listTypes();
        const all = await Promise.all(types.map((t) => store.search(t, q, limit).catch(() => [])));
        hits = all.flat().sort((a, b) => b.score - a.score).slice(0, limit);
      }
      res.json(
        hits.map((h) => ({
          id: h.memory.id,
          type: h.memory.type,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
        })),
      );
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.get('/:id', (req, res) => {
    const item = store.getById(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(item);
  });

  r.delete('/:id', async (req, res) => {
    await store.delete(req.params.id);
    res.json({ deleted: req.params.id });
  });

  return r;
}
