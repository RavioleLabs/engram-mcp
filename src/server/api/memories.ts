// src/server/api/memories.ts
import type { Router, Request, Response } from 'express';
import { Router as router } from 'express';
import multer from 'multer';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import type { MemoryStore } from '../../memory/core/store.js';
import { extractWikilinks } from '../../memory/core/wikilinks.js';
import { loadConfig } from '../../config/index.js';
import { transcribeAudio } from '../../memory/modules/audio/transcriber.js';
import { buildAudioItem } from '../../memory/modules/audio/ingest.js';
import { getDisabledTypes } from './types.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateMemorySchema = z.object({
  type: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  content: z.string(),
  properties: z.record(z.unknown()).optional(),
});

const PatchMemorySchema = z.object({
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  action_required: z.boolean().optional(),
  custom: z.record(z.unknown()).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function buildMemoryItem(
  type: string,
  content: string,
  title: string | undefined,
  tags: string[] | undefined,
  extraProperties: Record<string, unknown> = {},
  embeddingModel: string,
) {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    type,
    source_id: 'manual',
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    properties: {
      title,
      tags,
      created_at: now,
      ingested_at: now,
      ...extraProperties,
    },
    wikilinks: extractWikilinks(content),
    related_ids: [] as string[],
    embedding_model: embeddingModel,
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function memoriesApi(store: MemoryStore): Router {
  const r = router();

  // Multer: temp-dir storage, 50 MB limit
  const upload = multer({
    dest: path.join(os.tmpdir(), 'engram-uploads'),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  // -------------------------------------------------------------------------
  // GET /api/memories
  // -------------------------------------------------------------------------
  r.get('/', (req, res) => {
    const limit = Math.min(200, Number(req.query.limit ?? 50));
    const type = req.query.type as string | undefined;
    // include_disabled=true → returns ALL memories incl. user-disabled types and
    // memories with properties.custom.disabled=true. Default false hides them.
    // The brain viz uses include_disabled=true to gray them out; recall calls
    // leave it false so disabled memories don't pollute results.
    const includeDisabled = String(req.query.include_disabled ?? 'false') === 'true';

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

    const disabledTypes = getDisabledTypes();

    const items = rows
      .map((row) => {
        const props = JSON.parse(row.properties_json as string) as {
          custom?: { disabled?: boolean };
          [k: string]: unknown;
        };
        const typeDisabled = disabledTypes.has(row.type as string);
        const memDisabled = props.custom?.disabled === true;
        return {
          id: row.id,
          type: row.type,
          source_id: row.source_id,
          content_preview: (row.content as string).slice(0, 300),
          properties: props,
          created_at: row.created_at,
          disabled: typeDisabled || memDisabled,
          disabled_reason: typeDisabled
            ? ('type' as const)
            : memDisabled
              ? ('memory' as const)
              : null,
        };
      })
      .filter((m) => includeDisabled || !m.disabled);

    res.json(items);
  });

  // -------------------------------------------------------------------------
  // GET /api/memories/search
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // POST /api/memories — create a memory directly
  // -------------------------------------------------------------------------
  r.post('/', async (req: Request, res: Response) => {
    const parsed = CreateMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }
    const { type, title, tags, content, properties: extraProps } = parsed.data;
    const config = loadConfig();
    const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;
    const item = buildMemoryItem(type, content, title, tags, extraProps as Record<string, unknown>, embeddingModel);
    try {
      await store.insert(item);
      res.status(201).json(item);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/memories/ingest — URI-based ingestion (YouTube, Drive, Notion, ...)
  // Body: { uri: string, type?: string, title?: string, tags?: string[] }
  // Routes through the same `routeIngest` pipeline used by the MCP tool so
  // the dashboard's "Paste a YouTube URL" form has parity with agent ingest.
  // -------------------------------------------------------------------------
  r.post('/ingest', async (req: Request, res: Response) => {
    const body = req.body as { uri?: string; type?: string; title?: string; tags?: string[] };
    if (!body.uri || typeof body.uri !== 'string') {
      res.status(400).json({ error: 'uri_required' });
      return;
    }
    try {
      const { routeIngest } = await import('../../memory/public/tools.js');
      const config = loadConfig();
      const result = await routeIngest(body.uri, body.type, body.title, body.tags, store, config);
      res.status(201).json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: 'ingest_failed', message: msg });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/memories/upload — file upload (md/txt/pdf/audio/images)
  // -------------------------------------------------------------------------
  r.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    const config = loadConfig();
    const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;
    const { originalname, path: tmpPath, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();

    try {
      // ---- text/markdown ----
      if (ext === '.md' || ext === '.txt') {
        const content = fs.readFileSync(tmpPath, 'utf-8');
        const item = buildMemoryItem('notes', content, originalname, [], {}, embeddingModel);
        await store.insert(item);
        res.status(201).json({ id: item.id, type: 'notes', filename: originalname });
        return;
      }

      // ---- PDF ----
      if (ext === '.pdf') {
        const content = `[uploaded PDF: ${originalname}] — full text extraction pending`;
        const item = buildMemoryItem('notes', content, originalname, ['pdf'], { source_url: `file://${originalname}` }, embeddingModel);
        await store.insert(item);
        res.status(201).json({ id: item.id, type: 'notes', filename: originalname });
        return;
      }

      // ---- audio ----
      if (['.mp3', '.wav', '.m4a'].includes(ext)) {
        // Move temp file to a stable location so whisper can find it
        const audioDir = path.join(os.homedir(), '.engram', 'audio-uploads');
        fs.mkdirSync(audioDir, { recursive: true });
        const stablePath = path.join(audioDir, `${ulid()}-${originalname}`);
        fs.renameSync(tmpPath, stablePath);
        const transcript = await transcribeAudio(stablePath, config.whisper);
        const item = buildAudioItem({ audioPath: stablePath, transcript, embeddingModel });
        await store.insert(item);
        res.status(201).json({ id: item.id, type: 'audio', filename: originalname, duration: transcript.duration });
        return;
      }

      // ---- images ----
      if (['.png', '.jpg', '.jpeg'].includes(ext)) {
        const content = `[uploaded image: ${originalname}]`;
        const item = buildMemoryItem('images', content, originalname, ['image'], { source_url: `file://${originalname}`, mime_type: mimetype }, embeddingModel);
        await store.insert(item);
        res.status(201).json({ id: item.id, type: 'images', filename: originalname });
        return;
      }

      res.status(400).json({ error: 'unsupported_file_type', ext });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      // Clean up temp file if still present
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/memories/:id
  // -------------------------------------------------------------------------
  r.get('/:id', (req, res) => {
    const id = String(req.params.id);
    const item = store.getById(id);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(item);
  });

  // -------------------------------------------------------------------------
  // GET /api/memories/:id/related
  // -------------------------------------------------------------------------
  r.get('/:id/related', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const limit = Math.min(50, Number(req.query.limit ?? 10));
    try {
      const results = await store.findRelated(id, limit);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /api/memories/:id
  // -------------------------------------------------------------------------
  r.patch('/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const parsed = PatchMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }
    // Strip undefined keys
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    ) as Parameters<typeof store.setProperties>[1];

    const ok = store.setProperties(id, patch);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const updated = store.getById(id);
    res.status(200).json(updated);
  });

  // -------------------------------------------------------------------------
  // POST /api/memories/:id/disable   body: { disabled: boolean }
  //   Soft-toggle a memory's "disabled" flag (lives under properties.custom.disabled).
  //   The brain viz uses this for the gray-out / fade-out animation. Disabled
  //   memories are excluded from default recall/list calls but kept in storage.
  // -------------------------------------------------------------------------
  const ToggleDisabledSchema = z.object({ disabled: z.boolean() });
  r.post('/:id/disable', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const parsed = ToggleDisabledSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }
    const item = store.getById(id);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const newCustom = { ...(item.properties.custom ?? {}), disabled: parsed.data.disabled };
    const ok = store.setProperties(id, { custom: newCustom });
    if (!ok) {
      res.status(500).json({ error: 'update_failed' });
      return;
    }
    res.json({ id, disabled: parsed.data.disabled });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/memories/:id
  // -------------------------------------------------------------------------
  r.delete('/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const item = store.getById(id);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await store.delete(id);
    res.status(204).send();
  });

  // -------------------------------------------------------------------------
  // POST /api/memories/bulk-delete   body: { ids: string[] }
  //   Used by the brain viz when the user multi-selects and confirms.
  // -------------------------------------------------------------------------
  const BulkDeleteSchema = z.object({ ids: z.array(z.string()).min(1).max(500) });
  r.post('/bulk-delete', async (req: Request, res: Response) => {
    const parsed = BulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }
    const results: Array<{ id: string; deleted: boolean }> = [];
    for (const id of parsed.data.ids) {
      const item = store.getById(id);
      if (!item) {
        results.push({ id, deleted: false });
        continue;
      }
      await store.delete(id);
      results.push({ id, deleted: true });
    }
    res.json({ count: results.filter((r) => r.deleted).length, results });
  });

  return r;
}
