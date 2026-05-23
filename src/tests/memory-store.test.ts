// src/tests/memory-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
import { initDb, closeDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { MemoryStore } from '../memory/core/store.js';
import type { MemoryItem } from '../types.js';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

function buildItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    type: 'notes',
    source_id: 'local:test',
    content: 'Test content',
    content_hash: 'h1',
    properties: { created_at: now, ingested_at: now },
    wikilinks: [],
    related_ids: [],
    embedding_model: 'nomic-embed-text:v1.5',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-store-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts and retrieves a memory by id', async () => {
    const item = buildItem({ content: 'I love TypeScript' });
    await store.insert(item);
    const fetched = store.getById(item.id);
    expect(fetched?.id).toBe(item.id);
    expect(fetched?.content).toBe('I love TypeScript');
  });

  it('searches semantically and returns hits', async () => {
    const a = buildItem({ content: 'I love TypeScript', source_id: 'local:a' });
    const b = buildItem({ content: 'The weather is nice', source_id: 'local:b' });
    await store.insert(a);
    await store.insert(b);

    const hits = await store.search('notes', 'coding in TS', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].memory.id).toBe(a.id);
  });

  it('deletes a memory and removes it from results', async () => {
    const item = buildItem({ content: 'delete me' });
    await store.insert(item);
    await store.delete(item.id);

    expect(store.getById(item.id)).toBeUndefined();
    const hits = await store.search('notes', 'delete me', 5);
    expect(hits.find((h) => h.memory.id === item.id)).toBeUndefined();
  });

  it('findRelated returns items sharing a wikilink', async () => {
    const a = buildItem({
      content: 'Working on [[ProjectAlpha]] integration',
      source_id: 'local:a',
    });
    const b = buildItem({
      content: 'Status update for [[ProjectAlpha]]: stuck on auth',
      source_id: 'local:b',
    });
    const c = buildItem({ content: 'Unrelated content about weather', source_id: 'local:c' });
    await store.insert(a);
    await store.insert(b);
    await store.insert(c);

    // Set title 'ProjectAlpha' on b to make it the wikilink target
    store.setProperties(b.id, { title: 'ProjectAlpha' });

    const related = await store.findRelated(b.id, 5);
    expect(related.some((r) => r.memory.id === a.id)).toBe(true);
    expect(related.some((r) => r.memory.id === c.id)).toBe(false);
  });

  it('setProperties updates and persists', () => {
    const item = buildItem({ content: 'X' });
    return store.insert(item).then(() => {
      const ok = store.setProperties(item.id, { title: 'New Title', tags: ['x', 'y'] });
      expect(ok).toBe(true);
      const fetched = store.getById(item.id);
      expect(fetched?.properties.title).toBe('New Title');
      expect(fetched?.properties.tags).toEqual(['x', 'y']);
    });
  });
});

describe('MemoryStore with property extraction', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-store-extract-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({
      embeddings: embeddingsConfig,
      propertyExtraction: {
        enabled: true,
        baseUrl: 'http://localhost:11434',
        model: 'llama3.2:3b',
        maxTokens: 300,
      },
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fills missing properties (title, tags) automatically', async () => {
    const item = buildItem({
      content: 'Met with Alice about the new Polymarket integration; deadline April 15.',
    });
    await store.insert(item);
    const fetched = store.getById(item.id);
    expect(fetched?.properties.title).toBeTruthy();
    expect(fetched?.properties.tags?.length ?? 0).toBeGreaterThan(0);
  }, 60_000);
});
