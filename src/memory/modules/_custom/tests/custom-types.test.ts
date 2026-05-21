// src/memory/modules/_custom/tests/custom-types.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { moduleRegistry } from '../../../core/module-registry.js';
import { ToolRouter } from '../../../../mcp-server/tool-router.js';
import { buildCustomTypeTools, loadAndRegisterCustomTypes } from '../tools.js';
import { createCustomType, listCustomTypes, deleteCustomType } from '../persistence.js';
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
  modules: {},
  mcp: { stdio: true, httpPort: 7777 },
};

describe('custom types e2e', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let router: ToolRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-custom-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: config.embeddings });
    router = new ToolRouter();
    // Clear the registry between tests
    for (const m of moduleRegistry.list()) {
      (moduleRegistry as unknown as { modules: Map<string, unknown> }).modules.delete(m.id);
    }
    (moduleRegistry as unknown as { booted: boolean }).booted = false;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persistence: create + list + delete', () => {
    createCustomType({ type_name: 'recipes', display_name: 'Recipes' });
    let defs = listCustomTypes();
    expect(defs.map((d) => d.type_name)).toContain('recipes');
    deleteCustomType('recipes');
    defs = listCustomTypes();
    expect(defs.map((d) => d.type_name)).not.toContain('recipes');
  });

  it('rejects reserved names', () => {
    expect(() =>
      createCustomType({ type_name: 'notes', display_name: 'Notes' }),
    ).toThrow(/reserved/);
  });

  it(
    'create_custom_type registers add_X / search_X tools live',
    async () => {
      const tools = buildCustomTypeTools(store, config, router);
      const result = (await tools.find((t) => t.name === 'create_custom_type')!.handler({
        type_name: 'recipes',
        display_name: 'Recipes',
      })) as { type_name: string; tools: string[] };
      expect(result.tools).toContain('add_recipes');
      expect(result.tools).toContain('search_recipes');

      // The tool router now has them
      const addRecipe = router.list().find((t) => t.name === 'add_recipes')!;
      const searchRecipe = router.list().find((t) => t.name === 'search_recipes')!;

      await addRecipe.handler({
        content:
          'Pasta carbonara: pancetta, eggs, pecorino, black pepper. Tossed off-heat to keep eggs creamy.',
        title: 'Carbonara',
      });
      const hits = (await searchRecipe.handler({ query: 'pasta eggs cheese' })) as Array<{
        id: string;
      }>;
      expect(hits.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it('loadAndRegisterCustomTypes restores types at boot', async () => {
    createCustomType({ type_name: 'recipes', display_name: 'Recipes' });
    createCustomType({ type_name: 'dream_journal', display_name: 'Dream Journal' });

    loadAndRegisterCustomTypes(store, config, router);

    const toolNames = router.list().map((t) => t.name);
    expect(toolNames).toContain('add_recipes');
    expect(toolNames).toContain('search_recipes');
    expect(toolNames).toContain('add_dream_journal');
    expect(toolNames).toContain('search_dream_journal');
  });
});
