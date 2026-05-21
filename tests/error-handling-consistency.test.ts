// tests/error-handling-consistency.test.ts
// Regression: connect_drive, connect_notion, list_drive_files, list_notion_pages
// must ALL return {error, message, hint} in payload — never throw.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

// Config WITHOUT drive/notion credentials — triggers "not configured" path
const mockConfigNoOAuth = {
  embeddings: embeddingsConfig,
  dataDir: '',
  mcp: { stdio: true, httpPort: 7777 },
  propertyExtraction: { enabled: false },
  whisper: { model: 'base', language: 'auto' },
  youtube: {},
  // drive: undefined  (intentionally absent)
  // notion: undefined (intentionally absent)
} as Parameters<typeof buildPublicTools>[1];

describe('error handling consistency across OAuth + list tools', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-err-consistency-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('connect_drive without config returns {error, message, hint} — does NOT throw', async () => {
    const tools = buildPublicTools(store, mockConfigNoOAuth);
    const tool = tools.find((t) => t.name === 'connect_drive')!;

    let result: Record<string, unknown>;
    // Must not throw
    result = (await tool.handler({})) as Record<string, unknown>;

    expect(result.error).toBeTruthy();
    expect(typeof result.message).toBe('string');
    expect(typeof result.hint).toBe('string');
    expect(result.hint).toMatch(/clientId|credentials|config\.json/i);
  });

  it('connect_notion without config returns {error, message, hint} — does NOT throw', async () => {
    const tools = buildPublicTools(store, mockConfigNoOAuth);
    const tool = tools.find((t) => t.name === 'connect_notion')!;

    const result = (await tool.handler({})) as Record<string, unknown>;

    expect(result.error).toBeTruthy();
    expect(typeof result.message).toBe('string');
    expect(typeof result.hint).toBe('string');
    expect(result.hint).toMatch(/clientId|integrations|config\.json/i);
  });

  it('list_drive_files when not connected returns {error, message, hint} — does NOT throw', async () => {
    const tools = buildPublicTools(store, mockConfigNoOAuth);
    const tool = tools.find((t) => t.name === 'list_drive_files')!;

    const result = (await tool.handler({})) as Record<string, unknown>;

    expect(result.error).toBeTruthy();
    expect(typeof result.message).toBe('string');
    expect(typeof result.hint).toBe('string');
    expect(result.hint).toMatch(/connect_drive/i);
  });

  it('list_notion_pages when not connected returns {error, message, hint} — does NOT throw', async () => {
    const tools = buildPublicTools(store, mockConfigNoOAuth);
    const tool = tools.find((t) => t.name === 'list_notion_pages')!;

    const result = (await tool.handler({})) as Record<string, unknown>;

    expect(result.error).toBeTruthy();
    expect(typeof result.message).toBe('string');
    expect(typeof result.hint).toBe('string');
    expect(result.hint).toMatch(/connect_notion/i);
  });

  it('all four error responses are non-throwing (Promise resolves, not rejects)', async () => {
    const tools = buildPublicTools(store, mockConfigNoOAuth);
    const toolNames = ['connect_drive', 'connect_notion', 'list_drive_files', 'list_notion_pages'];

    for (const name of toolNames) {
      const tool = tools.find((t) => t.name === name)!;
      // Should resolve, not reject
      const result = await tool.handler({});
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>).error).toBeTruthy();
    }
  });
});
