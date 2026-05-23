import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { createNotesModule, buildNotesModuleTools } from '../module.js';
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
    enabled: true,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:3b',
    maxTokens: 300,
  },
  whisper: { enabled: true, model: 'small.en', language: 'auto' },
  youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: true },
  modules: { notes: { enabled: true } },
  mcp: { stdio: true, httpPort: 7777 },
};

describe('notes module', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-notes-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: config.embeddings });
    const mod = createNotesModule(config);
    await mod.onBoot({ store });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('add_note tool inserts and search_notes retrieves it', async () => {
    const tools = buildNotesModuleTools(store, config);
    const addNote = tools.find((t) => t.name === 'add_note')!;
    const searchNotes = tools.find((t) => t.name === 'search_notes')!;

    await addNote.handler({ content: 'EngramMCP is a memory layer for AI agents' });
    const results = (await searchNotes.handler({ query: 'AI memory' })) as Array<{
      id: string;
      score: number;
    }>;

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('extracts wikilinks from content', async () => {
    const mod = createNotesModule(config);
    await mod.onBoot({ store });
    const items = await mod.ingest({
      content: 'See [[ProjectX]] and [[Notes]].',
      source_id: 'manual:test',
    });
    expect(items[0].wikilinks).toEqual(['ProjectX', 'Notes']);
  });
});
