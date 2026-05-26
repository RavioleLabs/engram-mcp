// src/tests/describe-types.test.ts
// Discovery tool — returns rich per-type metadata so the agent can pick a
// narrow scope before recall. v0.6.1 §R3 + user request: when recall hints
// "narrow with types=[X]", describe_types tells you which type X actually is.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
import { initDb, closeDb, getDb } from '../db/index.js';
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
} as Parameters<typeof buildPublicTools>[1];

type TypeInfo = {
  name: string;
  count: number;
  top_tags: string[];
  last_activity_at: string | null;
  query_matches?: number;
};

// Insert memories directly via SQLite — bypass embeddings (don't need Ollama for these tests).
function seed(opts: { type: string; title: string; tags: string[]; content: string }) {
  const db = getDb();
  const id = ulid();
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, type, source_id, content, content_hash, properties_json,
       wikilinks_json, related_ids_json, embedding_model, created_at, scope,
       intent, importance, pinned, confidence)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', 'test', ?, 'personal', 'other', 'medium', 0, 1.0)`,
  ).run(
    id,
    opts.type,
    `src-${id}`,
    opts.content,
    `hash-${id}`,
    JSON.stringify({
      created_at: new Date(now).toISOString(),
      ingested_at: new Date(now).toISOString(),
      title: opts.title,
      tags: opts.tags,
    }),
    now,
  );
  db.prepare(`INSERT INTO memories_fts (id, content, title, tags) VALUES (?, ?, ?, ?)`).run(
    id,
    opts.content,
    opts.title,
    opts.tags.join(' '),
  );
}

describe('describe_types', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let describeTypes: (args: Record<string, unknown>) => Promise<{ types: TypeInfo[] }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-describe-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });

    seed({
      type: 'notes',
      title: 'Atlas kickoff',
      tags: ['atlas', 'meetings', 'alice'],
      content: 'Atlas project kickoff with Alice',
    });
    seed({
      type: 'notes',
      title: 'Sprint planning',
      tags: ['meetings', 'sprint'],
      content: 'Sprint 14 planning notes',
    });
    seed({
      type: 'notes',
      title: 'Alice 1:1 prep',
      tags: ['alice', 'meetings', '1on1'],
      content: 'Prep for Alice 1:1 tomorrow',
    });
    seed({
      type: 'drive',
      title: 'Q2 revenue projection',
      tags: ['finance', 'q2'],
      content: 'Q2 revenue projection spreadsheet',
    });
    seed({
      type: 'drive',
      title: 'Tax compliance memo',
      tags: ['finance', 'tax'],
      content: 'Tax compliance memo April',
    });

    const tools = buildPublicTools(store, mockConfig);
    const handler = tools.find((t) => t.name === 'describe_types')!.handler;
    describeTypes = (args) => handler(args) as Promise<{ types: TypeInfo[] }>;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns count, top tags, last activity per type — sorted by count desc when no query', async () => {
    const r = await describeTypes({});
    expect(r.types.map((t) => t.name)).toEqual(['notes', 'drive']);
    expect(r.types[0].count).toBe(3);
    expect(r.types[1].count).toBe(2);

    const notes = r.types[0];
    // Top tag for notes should be "meetings" (3 occurrences) ahead of "alice" (2) etc.
    expect(notes.top_tags[0]).toBe('meetings');
    expect(notes.top_tags).toContain('alice');
    expect(notes.last_activity_at).toBeTruthy();
    // No query: no query_matches field
    expect(notes.query_matches).toBeUndefined();
  });

  it('with query: returns query_matches per type and sorts by it desc', async () => {
    const r = await describeTypes({ query: 'Alice' });
    // notes has 2 hits (Atlas kickoff + Alice 1:1 prep); drive has 0.
    expect(r.types[0].name).toBe('notes');
    expect(r.types[0].query_matches).toBeGreaterThanOrEqual(2);
    expect(r.types[1].name).toBe('drive');
    expect(r.types[1].query_matches).toBe(0);
  });

  it('with query: types with 0 matches still appear (sorted by count as fallback)', async () => {
    const r = await describeTypes({ query: 'inexistantxyz' });
    expect(r.types).toHaveLength(2);
    for (const t of r.types) {
      expect(t.query_matches).toBe(0);
    }
    // With all-zero matches, secondary sort is count desc.
    expect(r.types[0].name).toBe('notes');
  });
});
