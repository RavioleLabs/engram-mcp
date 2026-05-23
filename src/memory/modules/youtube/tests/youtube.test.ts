// src/memory/modules/youtube/tests/youtube.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { buildYoutubeModuleTools } from '../module.js';
import type { EngramConfig } from '../../../../config/schema.js';

const config: EngramConfig = {
  dataDir: '~/.engram',
  embeddings: {
    provider: 'ollama' as const,
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 768,
  },
  drive: undefined,
  notion: undefined,
  propertyExtraction: {
    enabled: false,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:3b',
    maxTokens: 300,
  },
  whisper: { enabled: true, model: 'tiny.en', language: 'en' },
  youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: true },
  modules: { youtube: { enabled: true } },
  mcp: { stdio: true, httpPort: 7777 },
};

describe('youtube module e2e (real video)', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-yt-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: config.embeddings });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('add_youtube_url + search_youtube end-to-end', async () => {
    const tools = buildYoutubeModuleTools(store, config);
    const addRes = (await tools
      .find((t) => t.name === 'add_youtube_url')!
      .handler({
        url: 'https://www.youtube.com/watch?v=iG9CE55wbtY',
      })) as { id: string; title: string; segments: number };
    expect(addRes.id).toBeDefined();
    expect(addRes.segments).toBeGreaterThan(50);

    const hits = (await tools
      .find((t) => t.name === 'search_youtube')!
      .handler({
        query: 'creativity in schools',
      })) as Array<{ id: string; title: string }>;
    expect(hits.some((h) => h.id === addRes.id)).toBe(true);
  }, 120_000);
});
