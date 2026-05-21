// tests/watch-public.test.ts
// Verify watch/unwatch/list_sources are on the public surface (no --admin flag needed).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
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
  youtube: {},
} as Parameters<typeof buildPublicTools>[1];

describe('watch/unwatch/list_sources on public surface', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-watch-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('watch, unwatch, list_sources, create_type, delete_type are in the public surface', () => {
    const tools = buildPublicTools(store, mockConfig);
    const names = tools.map((t) => t.name);
    expect(names).toContain('watch');
    expect(names).toContain('unwatch');
    expect(names).toContain('list_sources');
    expect(names).toContain('create_type');
    expect(names).toContain('delete_type');
  });

  it('list_sources returns empty array when nothing is watched', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const listTool = tools.find((t) => t.name === 'list_sources')!;

    const result = (await listTool.handler({})) as Array<unknown>;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('watch(youtube, ...) registers source without --admin (mocked API call)', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const watchTool = tools.find((t) => t.name === 'watch')!;
    const listTool = tools.find((t) => t.name === 'list_sources')!;

    // Mock the youtube watcher's resolveChannelId to avoid real HTTP call
    vi.mock('../src/memory/modules/youtube/watcher.js', () => ({
      resolveChannelId: vi.fn().mockResolvedValue('UCfakeChannelId12345678901'),
    }));

    // The channel ID already looks like a real one, so resolveChannelId will return it as-is
    // (we use a fake ID that matches the UC... pattern to skip fetch)
    const fakeChannelId = 'UCfakeChannelId12345678901'; // 22 chars after UC — valid format

    const result = (await watchTool.handler({
      source_type: 'youtube',
      target_id: fakeChannelId,
      opts: { channelName: 'Test Channel' },
    })) as { watched: boolean; source_id: string; display_name: string };

    expect(result.watched).toBe(true);
    expect(result.source_id).toBeTruthy();

    // Verify it appears in list_sources
    const sources = (await listTool.handler({ source_type: 'youtube' })) as Array<{
      module_id: string;
      external_id: string;
    }>;
    expect(sources.some((s) => s.external_id === fakeChannelId)).toBe(true);

    vi.restoreAllMocks();
  });

  it('watch(obsidian, vault_path) indexes files from vault directory', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const watchTool = tools.find((t) => t.name === 'watch')!;

    // Create a fake obsidian vault with some .md files
    const vaultPath = path.join(tmpDir, 'test-vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'note1.md'), '# Note 1\nContent of note 1');
    fs.writeFileSync(path.join(vaultPath, 'note2.md'), '# Note 2\nContent of note 2');

    const result = (await watchTool.handler({
      source_type: 'obsidian',
      target_id: vaultPath,
    })) as { watched: boolean; source_id: string; files_indexed: number };

    expect(result.watched).toBe(true);
    expect(result.source_id).toBeTruthy();
    expect(result.files_indexed).toBe(2);
  });

  it('unwatch removes source by source_id', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const watchTool = tools.find((t) => t.name === 'watch')!;
    const unwatchTool = tools.find((t) => t.name === 'unwatch')!;
    const listTool = tools.find((t) => t.name === 'list_sources')!;

    // Watch a vault first
    const vaultPath = path.join(tmpDir, 'vault-to-unwatch');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'file.md'), '# Test');

    const watchResult = (await watchTool.handler({
      source_type: 'obsidian',
      target_id: vaultPath,
    })) as { source_id: string };

    // Unwatch by source_id
    const unwatchResult = (await unwatchTool.handler({
      source_id: watchResult.source_id,
    })) as { removed: boolean };
    expect(unwatchResult.removed).toBe(true);

    // Verify it's gone from list_sources
    const sources = (await listTool.handler({})) as Array<{ id: string }>;
    expect(sources.find((s) => s.id === watchResult.source_id)).toBeUndefined();
  });

  it('create_type and delete_type work from public surface', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const createTool = tools.find((t) => t.name === 'create_type')!;
    const deleteTool = tools.find((t) => t.name === 'delete_type')!;

    // Create a custom type
    const result = (await createTool.handler({
      name: 'books',
      display_name: 'Books',
    })) as { type_name: string; created: boolean };
    expect(result.type_name).toBe('books');
    expect(result.created).toBe(true);

    // Delete it (with confirm)
    const deleteResult = (await deleteTool.handler({
      name: 'books',
      confirm: true,
    })) as { deleted: string };
    expect(deleteResult.deleted).toBe('books');
  });

  it('delete_type without confirm returns error', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const createTool = tools.find((t) => t.name === 'create_type')!;
    const deleteTool = tools.find((t) => t.name === 'delete_type')!;

    await createTool.handler({ name: 'recipes', display_name: 'Recipes' });

    const result = (await deleteTool.handler({
      name: 'recipes',
      confirm: false,
    })) as { error: string };
    expect(result.error).toContain('confirm');
  });
});
