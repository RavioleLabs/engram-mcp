// src/webapp/api/sources.ts
import { Router } from 'express';
import { sourceRegistry } from '../../memory/core/source-registry.js';
import type { MemoryStore } from '../../memory/core/store.js';

export function sourcesApi(store?: MemoryStore): Router {
  const r = Router();
  r.get('/', (req, res) => {
    res.json(sourceRegistry.list(req.query.module_id as string | undefined));
  });
  r.delete('/:id', (req, res) => {
    sourceRegistry.remove(req.params.id);
    res.json({ removed: req.params.id });
  });
  r.post('/:id/disable', (req, res) => {
    sourceRegistry.setEnabled(req.params.id, false);
    res.json({ disabled: req.params.id });
  });
  r.post('/:id/enable', (req, res) => {
    sourceRegistry.setEnabled(req.params.id, true);
    res.json({ enabled: req.params.id });
  });

  // POST /api/sources/youtube/import-playlist
  r.post('/youtube/import-playlist', async (req, res) => {
    const { playlistUrl, limit } = req.body as { playlistUrl?: string; limit?: number };
    if (!playlistUrl) {
      res.status(400).json({ error: 'playlistUrl is required' });
      return;
    }
    if (!store) {
      res.status(503).json({ error: 'Memory store not available' });
      return;
    }
    try {
      const { importPlaylist } = await import('../../memory/modules/youtube/watcher.js');
      const { loadConfig } = await import('../../config/index.js');
      const config = loadConfig();
      const result = await importPlaylist(playlistUrl, store, config.embeddings, config.youtube, limit ?? 50);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return r;
}
