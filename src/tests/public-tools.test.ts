// src/tests/public-tools.test.ts
// Tests for the 10-tool public surface (v0.2).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
import { initDb, closeDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { MemoryStore } from '../memory/core/store.js';
import { buildPublicTools } from '../memory/public/tools.js';

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
  ingest: { allowedPaths: [os.tmpdir()] },
} as Parameters<typeof buildPublicTools>[1];

describe('public tools — full 24-tool surface', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-public-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });

    const now = new Date().toISOString();
    await store.insert({
      id: ulid(),
      type: 'notes',
      source_id: 'manual:1',
      content: 'TypeScript is great for type-safe code',
      content_hash: 'h1',
      properties: { created_at: now, ingested_at: now, title: 'TS basics', tags: ['typescript'] },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'nomic-embed-text:v1.5',
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Verify the surface has exactly the expected public tools (no admin flag)
  it('exposes the expected public tools', () => {
    const tools = buildPublicTools(store, mockConfig);
    const names = tools.map((t) => t.name);
    // Core memory tools
    expect(names).toContain('remember');
    expect(names).toContain('recall');
    expect(names).toContain('get');
    expect(names).toContain('update');
    expect(names).toContain('forget');
    expect(names).toContain('relate');
    expect(names).toContain('list_types');
    expect(names).toContain('describe_types');
    expect(names).toContain('recent');
    expect(names).toContain('ingest');
    expect(names).toContain('suggest_properties');
    expect(names).toContain('get_ingest_status');
    // Watch/source tools
    expect(names).toContain('watch');
    expect(names).toContain('unwatch');
    expect(names).toContain('list_sources');
    // Type tools
    expect(names).toContain('create_type');
    expect(names).toContain('delete_type');
    // Previously-admin tools (now public)
    expect(names).toContain('connect_drive');
    expect(names).toContain('list_drive_files');
    expect(names).toContain('connect_notion');
    expect(names).toContain('list_notion_pages');
    expect(names).toContain('import_watch_later');
    // Cross-memory inference tools
    expect(names).toContain('analyze_patterns');
    expect(names).toContain('summarize_recent');
    expect(names).toContain('find_gaps');
  });

  it('list_types returns active types', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const result = (await tools.find((t) => t.name === 'list_types')!.handler({})) as {
      types: string[];
    };
    expect(result.types).toContain('notes');
  });

  it('remember writes a memory and returns id + wikilinks_extracted', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const result = (await tools
      .find((t) => t.name === 'remember')!
      .handler({
        content: 'Discussed [[Atlas]] project with [[Alice]]',
        title: 'Atlas kickoff',
        tags: ['atlas', 'alice'],
        type: 'notes',
      })) as { id: string; wikilinks_extracted: string[] };
    expect(result.id).toBeTruthy();
    expect(result.wikilinks_extracted).toEqual(expect.arrayContaining(['Atlas', 'Alice']));
    const stored = store.getById(result.id);
    expect(stored?.properties.title).toBe('Atlas kickoff');
    expect(stored?.properties.tags).toContain('atlas');
  });

  it('recall returns envelope with results + confidence', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const envelope = (await tools
      .find((t) => t.name === 'recall')!
      .handler({
        query: 'coding typescript',
        limit: 5,
      })) as {
      results: Array<{ id: string; type: string; score: number }>;
      confidence: 'high' | 'medium' | 'low' | 'none';
      hint?: string;
    };
    expect(envelope.results.length).toBeGreaterThan(0);
    expect(envelope.results[0].type).toBe('notes');
    expect(['high', 'medium', 'low']).toContain(envelope.confidence);
  });

  it('get retrieves full memory by id', async () => {
    const tools = buildPublicTools(store, mockConfig);
    // First insert a known memory
    const now = new Date().toISOString();
    const id = ulid();
    await store.insert({
      id,
      type: 'notes',
      source_id: 'get-test',
      content: 'get me',
      content_hash: 'gm',
      properties: { created_at: now, ingested_at: now, title: 'get-test-title' },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'm',
    });
    const result = (await tools.find((t) => t.name === 'get')!.handler({ id })) as {
      id: string;
      content: string;
    };
    expect(result.id).toBe(id);
    expect(result.content).toBe('get me');
  });

  it('get returns not_found for unknown id', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const result = (await tools.find((t) => t.name === 'get')!.handler({ id: 'nope' })) as {
      error: string;
    };
    expect(result.error).toBe('not_found');
  });

  it('update mutates title and tags', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const now = new Date().toISOString();
    const id = ulid();
    await store.insert({
      id,
      type: 'notes',
      source_id: 'upd',
      content: 'edit me',
      content_hash: 'e',
      properties: { created_at: now, ingested_at: now },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'm',
    });
    const result = (await tools
      .find((t) => t.name === 'update')!
      .handler({
        id,
        title: 'Renamed',
        tags: ['important'],
      })) as { updated: boolean };
    expect(result.updated).toBe(true);
    expect(store.getById(id)?.properties.title).toBe('Renamed');
    expect(store.getById(id)?.properties.tags).toContain('important');
  });

  it('forget removes item from store', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const now = new Date().toISOString();
    const id = ulid();
    await store.insert({
      id,
      type: 'notes',
      source_id: 'del',
      content: 'delete me',
      content_hash: 'd',
      properties: { created_at: now, ingested_at: now },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'm',
    });
    await tools.find((t) => t.name === 'forget')!.handler({ id });
    expect(store.getById(id)).toBeUndefined();
  });

  it('relate returns memories sharing wikilinks', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const now = new Date().toISOString();
    const aId = ulid();
    const bId = ulid();
    await store.insert({
      id: aId,
      type: 'notes',
      source_id: 'a',
      content: 'Working on [[ProjectAlpha]]',
      content_hash: 'a',
      properties: { created_at: now, ingested_at: now, title: 'note-a' },
      wikilinks: ['ProjectAlpha'],
      related_ids: [],
      embedding_model: 'm',
    });
    await store.insert({
      id: bId,
      type: 'notes',
      source_id: 'b',
      content: 'Alpha project notes',
      content_hash: 'b',
      properties: { created_at: now, ingested_at: now, title: 'ProjectAlpha' },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'm',
    });
    const result = (await tools
      .find((t) => t.name === 'relate')!
      .handler({
        id: bId,
      })) as Array<{ id: string }>;
    expect(result.some((r) => r.id === aId)).toBe(true);
  });

  it('recent returns latest memories sorted by date', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const result = (await tools
      .find((t) => t.name === 'recent')!
      .handler({
        limit: 5,
      })) as Array<{ id: string; type: string; created_at: string }>;
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].type).toBeTruthy();
  });

  it('ingest routes .md file correctly', async () => {
    const tools = buildPublicTools(store, mockConfig);
    // Write a temp md file
    const mdPath = path.join(os.tmpdir(), `test-${ulid()}.md`);
    fs.writeFileSync(mdPath, '# Test Note\n\nThis is content for ingest test.');
    try {
      const result = (await tools
        .find((t) => t.name === 'ingest')!
        .handler({
          uri: mdPath,
          tags: ['test'],
        })) as { id: string; type: string; title: string };
      expect(result.id).toBeTruthy();
      expect(result.type).toBe('notes');
    } finally {
      fs.unlinkSync(mdPath);
    }
  });

  it('suggest_properties returns content + instruction', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const now = new Date().toISOString();
    const id = ulid();
    await store.insert({
      id,
      type: 'notes',
      source_id: 'sp:1',
      content: 'Plan a quarterly all-hands. Action: confirm venue by Friday.',
      content_hash: 'sp1',
      properties: { created_at: now, ingested_at: now },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'm',
    });
    const result = (await tools
      .find((t) => t.name === 'suggest_properties')!
      .handler({
        id,
      })) as {
      memory_id: string;
      type: string;
      content: string;
      current_properties: { title: string | null; tags: string[] };
      instruction: string;
    };
    expect(result.memory_id).toBe(id);
    expect(result.content).toContain('quarterly all-hands');
    expect(result.current_properties.title).toBeNull();
    expect(result.instruction).toContain('update');
    expect(result.instruction).toContain('title');
  });

  it('suggest_properties returns error for unknown id', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const result = (await tools
      .find((t) => t.name === 'suggest_properties')!
      .handler({
        id: 'nonexistent',
      })) as { error: string };
    expect(result.error).toBe('not_found');
  });
});
