import { Router } from 'express';
import { loadConfig } from '../../config/index.js';
import { reindexAll } from '../../memory/core/reindex.js';

export function reindexApi(): Router {
  const r = Router();
  r.post('/', async (_req, res) => {
    try {
      const config = loadConfig();
      const result = await reindexAll(config.embeddings);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  return r;
}
