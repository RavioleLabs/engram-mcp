// src/memory/modules/audio/tests/audio.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { buildAudioModuleTools } from '../module.js';
import type { EngramConfig } from '../../../../config/schema.js';

const TEST_AUDIO = path.join(import.meta.dirname, 'fixtures', 'hello.wav');

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
  modules: { audio: { enabled: true } },
  mcp: { stdio: true, httpPort: 7777 },
};

describe('audio module e2e (real Whisper + LanceDB)', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-audio-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: config.embeddings });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('add_audio_file → search_audio finds the transcript', async () => {
    if (!fs.existsSync(TEST_AUDIO)) {
      console.warn('Skipping: hello.wav fixture not generated');
      return;
    }
    const tools = buildAudioModuleTools(store, config);
    const addRes = (await tools
      .find((t) => t.name === 'add_audio_file')!
      .handler({
        path: TEST_AUDIO,
      })) as { id: string; duration: number };
    expect(addRes.id).toBeDefined();
    expect(addRes.duration).toBeGreaterThan(0);

    const hits = (await tools
      .find((t) => t.name === 'search_audio')!
      .handler({
        query: 'hello test',
      })) as Array<{ id: string }>;
    expect(hits.some((h) => h.id === addRes.id)).toBe(true);
  }, 180_000);
});
