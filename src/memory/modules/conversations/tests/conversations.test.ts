import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { createConversationsModule, buildConversationsModuleTools } from '../module.js';
import type { EngramConfig } from '../../../../config/schema.js';

const config: EngramConfig = {
  dataDir: '~/.engram',
  embeddings: { provider: 'ollama' as const, baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', dimensions: 768 },
  drive: undefined,
  notion: undefined,
  propertyExtraction: {
    enabled: false, // keep tests fast; extraction tested separately
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:3b',
    maxTokens: 300,
  },
  whisper: { enabled: true, model: 'small.en', language: 'auto' },
  youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: true },
  modules: { conversations: { enabled: true } },
  mcp: { stdio: true, httpPort: 7777 },
};

describe('conversations module', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-conv-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: config.embeddings });
    const mod = createConversationsModule(config);
    await mod.onBoot({ store });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('remember_exchange stores and search_conversations retrieves it', async () => {
    const tools = buildConversationsModuleTools(store, config);
    const remember = tools.find((t) => t.name === 'remember_exchange')!;
    const search = tools.find((t) => t.name === 'search_conversations')!;

    await remember.handler({
      user_message: 'What do you think of bonding curves for prediction markets?',
      assistant_message:
        'Bonding curves give continuous liquidity and avoid the LP problem of CPMM. Trade-off: harder pricing.',
      agent: 'claude-code',
    });

    const results = (await search.handler({ query: 'prediction market liquidity' })) as Array<{
      id: string;
      score: number;
      agent: string;
    }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].agent).toBe('claude-code');
    expect(results[0].score).toBeGreaterThan(0.3);
  }, 30_000);

  it('ingest() via module accepts JSON content', async () => {
    const mod = createConversationsModule(config);
    await mod.onBoot({ store });
    const items = await mod.ingest({
      content: JSON.stringify({
        user_message: 'hi',
        assistant_message: 'hello',
      }),
      source_id: 'test:1',
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('conversations');
    expect(items[0].content).toContain('User: hi');
    expect(items[0].content).toContain('Assistant: hello');
  });
});
