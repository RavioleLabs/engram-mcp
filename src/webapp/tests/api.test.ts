// src/webapp/tests/api.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { initDb, closeDb } from '../../db/index.js';
import { initVectorStore } from '../../vector/store.js';
import { MemoryStore } from '../../memory/core/store.js';
import { memoriesApi } from '../api/memories.js';
import { viewsApi } from '../api/views.js';
import { dailyApi } from '../api/daily.js';
import { settingsApi } from '../api/settings.js';
import { ulid } from 'ulid';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

describe('webapp REST API', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let app: express.Express;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-api-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });

    app = express();
    // strict: false is required so settings can store any JSON value (string, number, bool, etc.)
    app.use(express.json({ strict: false }));
    app.use('/api/memories', memoriesApi(store));
    app.use('/api/views', viewsApi());
    app.use('/api/daily', dailyApi());
    app.use('/api/settings', settingsApi());
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('memories: list + get + delete', async () => {
    const now = new Date().toISOString();
    const id = ulid();
    await store.insert({
      id,
      type: 'notes',
      source_id: 'x',
      content: 'hello',
      content_hash: 'h',
      properties: { created_at: now, ingested_at: now },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'm',
    });

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const list = await fetch(`http://localhost:${port}/api/memories`);
      const body = (await list.json()) as Array<{ id: string }>;
      expect(body.some((m) => m.id === id)).toBe(true);

      const single = await fetch(`http://localhost:${port}/api/memories/${id}`);
      const itemBody = (await single.json()) as { id: string; content: string };
      expect(itemBody.content).toBe('hello');

      const del = await fetch(`http://localhost:${port}/api/memories/${id}`, {
        method: 'DELETE',
      });
      expect(del.ok).toBe(true);
      expect(store.getById(id)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('views: create + list + update + delete', async () => {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const create = await fetch(`http://localhost:${port}/api/views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Recent notes',
          definition: { filters: [{ field: 'type', op: 'eq', value: 'notes' }] },
        }),
      });
      const { id } = (await create.json()) as { id: string };

      const list = await fetch(`http://localhost:${port}/api/views`);
      const views = (await list.json()) as Array<{ id: string; name: string }>;
      expect(views.find((v) => v.id === id)?.name).toBe('Recent notes');

      const upd = await fetch(`http://localhost:${port}/api/views/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(upd.ok).toBe(true);

      const del = await fetch(`http://localhost:${port}/api/views/${id}`, {
        method: 'DELETE',
      });
      expect(del.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('settings: read/write', async () => {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const put = await fetch(`http://localhost:${port}/api/settings/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('dark'),
      });
      expect(put.ok).toBe(true);
      const get = await fetch(`http://localhost:${port}/api/settings`);
      const body = (await get.json()) as { theme: string };
      expect(body.theme).toBe('dark');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
