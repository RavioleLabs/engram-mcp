// tests/import-watch-later-status.test.ts
// Regression: import_watch_later response must always include a "status" field.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// vi.mock must be hoisted (top level) to intercept dynamic imports inside the handler
vi.mock('../src/memory/modules/youtube/watcher.js', () => ({
  importPlaylist: vi.fn().mockResolvedValue({ imported: 3, skipped: 1 }),
  resolveChannelId: vi.fn().mockResolvedValue('UCtest12345678901234567'),
  startChannelCron: vi.fn(),
  pollChannel: vi.fn().mockResolvedValue({ ingested: 0 }),
}));

import { initDb, closeDb } from '../src/db/index.js';
import { initVectorStore } from '../src/vector/store.js';
import { MemoryStore } from '../src/memory/core/store.js';
import { buildPublicTools } from '../src/memory/public/tools.js';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

const mockConfig = {
  embeddings: embeddingsConfig,
  dataDir: '',
  mcp: { stdio: true, httpPort: 7777 },
  propertyExtraction: { enabled: false },
  whisper: { model: 'base', language: 'auto' },
  youtube: { preferLanguage: 'en', fallbackToYtdlp: false },
} as Parameters<typeof buildPublicTools>[1];

describe('import_watch_later response always includes status field', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wl-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('import_watch_later always returns a status field', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const tool = tools.find((t) => t.name === 'import_watch_later')!;

    const result = (await tool.handler({
      playlistUrl: 'https://www.youtube.com/playlist?list=WL',
    })) as Record<string, unknown>;

    // Must always include status
    expect(result.status).toBeDefined();
    expect(typeof result.status).toBe('string');
    // For sync small imports, status should be "completed"
    expect(result.status).toBe('completed');
  });

  it('import_watch_later status field is "completed" for sync imports', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const tool = tools.find((t) => t.name === 'import_watch_later')!;

    const result = (await tool.handler({
      playlistUrl: 'https://www.youtube.com/playlist?list=WL',
      limit: 5,
    })) as Record<string, unknown>;

    expect(result.status).toBe('completed');
  });

  it('import_watch_later response shape matches documented {status, imported?, skipped?}', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const tool = tools.find((t) => t.name === 'import_watch_later')!;

    const result = (await tool.handler({
      playlistUrl: 'https://www.youtube.com/playlist?list=WL',
    })) as Record<string, unknown>;

    // Core documented fields
    expect(result).toHaveProperty('status');
    // Original fields from importPlaylist should also be present
    expect(result).toHaveProperty('imported');
    expect(result).toHaveProperty('skipped');
  });
});
