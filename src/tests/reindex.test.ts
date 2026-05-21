import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
import { initDb, closeDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { MemoryStore } from '../memory/core/store.js';
import { reindexAll } from '../memory/core/reindex.js';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

describe('reindexAll', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-reindex-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });

    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await store.insert({
        id: ulid(),
        type: 'notes',
        source_id: `s${i}`,
        content: `Note number ${i} about TypeScript and memory`,
        content_hash: `h${i}`,
        properties: { created_at: now, ingested_at: now },
        wikilinks: [],
        related_ids: [],
        embedding_model: 'nomic-embed-text:v1',
      });
    }
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reindexes all memories under a new embedding config', async () => {
    const result = await reindexAll({ ...embeddingsConfig, model: 'nomic-embed-text' });
    expect(result.total).toBe(3);
    expect(result.types).toContain('notes');

    // Search still works after reindex
    const hits = await store.search('notes', 'TypeScript memory', 5);
    expect(hits.length).toBeGreaterThan(0);
  }, 60_000);

  it('emits progress callbacks per memory', async () => {
    const progress: Array<{ type: string; processed: number; total: number }> = [];
    await reindexAll({ ...embeddingsConfig }, (p) => progress.push({ ...p }));
    expect(progress.length).toBe(3);
    expect(progress[2].processed).toBe(3);
  }, 60_000);
});
