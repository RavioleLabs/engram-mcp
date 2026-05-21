import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { buildObsidianModuleTools, createObsidianModule } from '../module.js';
import type { EngramConfig } from '../../../../config/schema.js';

const config: EngramConfig = {
  dataDir: '~/.engram',
  embeddings: { provider: 'ollama' as const, baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', dimensions: 768 },
  drive: undefined,
  notion: undefined,
  propertyExtraction: {
    enabled: false,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:3b',
    maxTokens: 300,
  },
  whisper: { enabled: true, model: 'small.en', language: 'auto' },
  youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: false },
  modules: { obsidian: { enabled: true } },
  mcp: { stdio: true, httpPort: 7777 },
};

describe('obsidian module e2e', () => {
  let tmpData: string;
  let vault: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-obs-data-'));
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-obs-vault-'));
    initDb(tmpData);
    initVectorStore(tmpData);
    store = new MemoryStore({ embeddings: config.embeddings });

    fs.writeFileSync(
      path.join(vault, 'engineering-standards.md'),
      `---\ntitle: Engineering Standards\ntags: [code, standards]\n---\n# Engineering Standards\n\nUse TypeScript strict mode and ULIDs.\n\nSee [[Code Review]] for review process.\n`,
    );
    fs.writeFileSync(
      path.join(vault, 'code-review.md'),
      `# Code Review\n\nEvery PR needs at least 1 reviewer.\n`,
    );

    const mod = createObsidianModule(config);
    await mod.onBoot({ store });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it(
    'add_obsidian_vault indexes every markdown file',
    async () => {
      const tools = buildObsidianModuleTools(store, config);
      const result = (await tools.find((t) => t.name === 'add_obsidian_vault')!.handler({
        vault_path: vault,
      })) as { files_ingested: number };
      expect(result.files_ingested).toBe(2);
    },
    30_000,
  );

  it(
    'parses frontmatter title and tags',
    async () => {
      const tools = buildObsidianModuleTools(store, config);
      await tools.find((t) => t.name === 'add_obsidian_vault')!.handler({ vault_path: vault });

      const types = store.listTypes();
      expect(types).toContain('obsidian');

      const hits = await store.search('obsidian', 'standards typescript ULID', 5);
      expect(hits.length).toBeGreaterThan(0);
      const top = hits[0].memory;
      expect(top.properties.title).toBe('Engineering Standards');
      expect(top.properties.tags).toContain('code');
      expect(top.wikilinks).toContain('Code Review');
    },
    30_000,
  );
});
