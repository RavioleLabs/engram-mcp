// tests/suggest-properties-instruction.test.ts
// Regression: suggest_properties instruction must say "update", NOT "set_properties".
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

describe('suggest_properties instruction references "update" not "set_properties"', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sugprop-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('suggest_properties instruction says "update" and does NOT say "set_properties"', async () => {
    const tools = buildPublicTools(store, mockConfig);

    // First remember a memory so we have an id to pass
    const rememberTool = tools.find((t) => t.name === 'remember')!;
    const rememberResult = (await rememberTool.handler({
      content: 'Test content for suggest_properties regression test',
    })) as { id: string };

    const suggestTool = tools.find((t) => t.name === 'suggest_properties')!;
    const result = (await suggestTool.handler({ id: rememberResult.id })) as {
      instruction: string;
      memory_id: string;
    };

    expect(result.instruction).toBeTruthy();
    // Must NOT say set_properties
    expect(result.instruction).not.toContain('set_properties');
    // Must say "update"
    expect(result.instruction).toContain('update');
  });
});
