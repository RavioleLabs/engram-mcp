// tests/watch-idempotency.test.ts
// Regression: watch() must be idempotent (second call returns already_watching: true).
// Regression: unwatch() must be idempotent (second call returns removed: true, already_removed: true).
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

const mockConfig = {
  embeddings: embeddingsConfig,
  dataDir: '',
  mcp: { stdio: true, httpPort: 7777 },
  propertyExtraction: { enabled: false },
  whisper: { model: 'base', language: 'auto' },
  youtube: {},
} as Parameters<typeof buildPublicTools>[1];

describe('watch() idempotency', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-watch-idem-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calling watch() twice on same obsidian vault does NOT error and returns already_watching: true on second call', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const watchTool = tools.find((t) => t.name === 'watch')!;

    // Create a fake vault
    const vaultPath = path.join(tmpDir, 'my-vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'note.md'), '# Note\nContent');

    // First call
    const first = (await watchTool.handler({
      source_type: 'obsidian',
      target_id: vaultPath,
    })) as { watched: boolean; source_id: string; already_watching?: boolean };

    expect(first.watched).toBe(true);
    expect(first.already_watching).toBeUndefined(); // first time: no already_watching flag
    expect(first.source_id).toBeTruthy();

    // Second call — same target
    const second = (await watchTool.handler({
      source_type: 'obsidian',
      target_id: vaultPath,
    })) as { watched: boolean; source_id: string; already_watching?: boolean; error?: string };

    // Must NOT error
    expect(second.error).toBeUndefined();
    expect(second.watched).toBe(true);
    expect(second.already_watching).toBe(true);
    // Returns same source_id
    expect(second.source_id).toBe(first.source_id);
  });

  it('watch() twice does not create duplicate entries in list_sources', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const watchTool = tools.find((t) => t.name === 'watch')!;
    const listTool = tools.find((t) => t.name === 'list_sources')!;

    const vaultPath = path.join(tmpDir, 'vault-dedup');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'a.md'), '# A');

    await watchTool.handler({ source_type: 'obsidian', target_id: vaultPath });
    await watchTool.handler({ source_type: 'obsidian', target_id: vaultPath });

    const sources = (await listTool.handler({})) as Array<{ external_id: string }>;
    const matches = sources.filter((s) => s.external_id === path.resolve(vaultPath));
    expect(matches).toHaveLength(1);
  });
});

describe('unwatch() idempotency', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-unwatch-idem-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calling unwatch() twice on same source_id does NOT error — second call returns already_removed: true', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const watchTool = tools.find((t) => t.name === 'watch')!;
    const unwatchTool = tools.find((t) => t.name === 'unwatch')!;

    const vaultPath = path.join(tmpDir, 'vault-unwatch');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'b.md'), '# B');

    const watchResult = (await watchTool.handler({
      source_type: 'obsidian',
      target_id: vaultPath,
    })) as { source_id: string };

    // First unwatch
    const first = (await unwatchTool.handler({
      source_id: watchResult.source_id,
    })) as { removed: boolean; already_removed?: boolean; error?: string };

    expect(first.error).toBeUndefined();
    expect(first.removed).toBe(true);
    expect(first.already_removed).toBeUndefined(); // first time: not flagged

    // Second unwatch — same source_id, already removed
    const second = (await unwatchTool.handler({
      source_id: watchResult.source_id,
    })) as { removed: boolean; already_removed?: boolean; error?: string };

    expect(second.error).toBeUndefined();
    expect(second.removed).toBe(true);
    expect(second.already_removed).toBe(true);
  });

  it('unwatch() on unknown source_id returns removed: true (idempotent, not error)', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const unwatchTool = tools.find((t) => t.name === 'unwatch')!;

    const result = (await unwatchTool.handler({
      source_id: '01FAKE000000000000000000XX',
    })) as { removed: boolean; already_removed?: boolean; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.removed).toBe(true);
    expect(result.already_removed).toBe(true);
  });
});
