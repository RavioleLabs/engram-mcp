// tests/anti-loop-contracts.test.ts
// Verify idempotency contracts for anti-loop hardening:
//   - remember twice → same id, second returns {created: false}
//   - update no-op → {updated: false}
//   - forget twice → both succeed
//   - watch twice → second returns {already_watching: true}
//   - create_type twice → second returns {created: false}
//   - get_ingest_status poll_count increments + retry_after_ms grows
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../src/db/index.js';
import { initVectorStore } from '../src/vector/store.js';
import { MemoryStore } from '../src/memory/core/store.js';
import { buildPublicTools } from '../src/memory/public/tools.js';
import type { EngramConfig } from '../src/config/schema.js';

const mockConfig: EngramConfig = {
  dataDir: '',
  embeddings: {
    provider: 'ollama' as const,
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 768,
  },
  drive: undefined,
  notion: undefined,
  propertyExtraction: { enabled: false, baseUrl: 'http://localhost:11434', model: 'llama3.2:3b', maxTokens: 300 },
  whisper: { enabled: true, model: 'small.en', language: 'auto' },
  youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: false },
  modules: {},
  mcp: { stdio: true, httpPort: 7777 },
};

describe('anti-loop idempotency contracts', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: ReturnType<typeof buildPublicTools>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-antiloop-'));
    mockConfig.dataDir = tmpDir;
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: mockConfig.embeddings });
    tools = buildPublicTools(store, mockConfig);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── remember ─────────────────────────────────────────────────────────────────
  it('remember: duplicate content returns same id with created: false', async () => {
    const rememberTool = tools.find((t) => t.name === 'remember')!;
    const content = 'The capital of France is Paris. A fact worth remembering.';

    const first = (await rememberTool.handler({
      content,
      title: 'Paris capital',
      tags: ['geography', 'france'],
    })) as { id: string; created: boolean };

    expect(first.created).toBe(true);
    expect(first.id).toBeTruthy();

    const second = (await rememberTool.handler({
      content,
      title: 'Paris capital',
      tags: ['geography', 'france'],
    })) as { id: string; created: boolean; reason: string };

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.reason).toBe('duplicate');
  });

  // ── update ────────────────────────────────────────────────────────────────────
  it('update: no-op patch returns {updated: false}', async () => {
    const rememberTool = tools.find((t) => t.name === 'remember')!;
    const updateTool = tools.find((t) => t.name === 'update')!;

    const { id } = (await rememberTool.handler({
      content: 'Test memory for update no-op contract.',
      title: 'Test Memory',
      tags: ['test'],
    })) as { id: string };

    // First update — sets title
    const first = (await updateTool.handler({ id, title: 'Updated Title' })) as { updated: boolean };
    expect(first.updated).toBe(true);

    // Second update — same value, no change
    const second = (await updateTool.handler({ id, title: 'Updated Title' })) as { updated: boolean };
    expect(second.updated).toBe(false);
  });

  // ── forget ────────────────────────────────────────────────────────────────────
  it('forget: calling twice both succeed without error', async () => {
    const rememberTool = tools.find((t) => t.name === 'remember')!;
    const forgetTool = tools.find((t) => t.name === 'forget')!;

    const { id } = (await rememberTool.handler({
      content: 'Memory to be forgotten twice.',
      title: 'Ephemeral',
      tags: ['test'],
    })) as { id: string };

    const first = (await forgetTool.handler({ id })) as { deleted: string };
    expect(first.deleted).toBe(id);

    // Second call — already deleted but should not throw
    const second = (await forgetTool.handler({ id })) as { deleted: string };
    expect(second.deleted).toBe(id);
  });

  // ── create_type ───────────────────────────────────────────────────────────────
  it('create_type: duplicate name returns existing with created: false', async () => {
    const createTypeTool = tools.find((t) => t.name === 'create_type')!;

    const first = (await createTypeTool.handler({
      name: 'antiloop_test_type',
      display_name: 'Anti-Loop Test',
    })) as { type_name: string; created: boolean };

    expect(first.created).toBe(true);
    expect(first.type_name).toBe('antiloop_test_type');

    const second = (await createTypeTool.handler({
      name: 'antiloop_test_type',
      display_name: 'Anti-Loop Test',
    })) as { type_name: string; created: boolean };

    expect(second.created).toBe(false);
    expect(second.type_name).toBe('antiloop_test_type');
  });

  // ── get_ingest_status — poll_count + retry hints ──────────────────────────────
  it('get_ingest_status: poll_count increments and retry_after_ms grows', async () => {
    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const statusTool = tools.find((t) => t.name === 'get_ingest_status')!;

    // Fake .mp3 path triggers async job
    const fakeMp3 = path.join(tmpDir, 'poll-test.mp3');
    const { job_id } = (await ingestTool.handler({ uri: fakeMp3 })) as { job_id: string };
    expect(job_id).toBeTruthy();

    // First poll — poll_count was 0 before this call
    const poll1 = (await statusTool.handler({ job_id })) as {
      retry_after_ms: number;
      should_give_up: boolean;
    };
    expect(poll1.retry_after_ms).toBe(2000); // 1000 * 2^1
    expect(poll1.should_give_up).toBe(false);

    // Second poll — poll_count is now 1 → retry_after_ms = 1000 * 2^2 = 4000
    const poll2 = (await statusTool.handler({ job_id })) as {
      retry_after_ms: number;
      should_give_up: boolean;
    };
    expect(poll2.retry_after_ms).toBe(4000); // 1000 * 2^2
    expect(poll2.should_give_up).toBe(false);
  });

  it('get_ingest_status: should_give_up is true after 10 polls', async () => {
    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const statusTool = tools.find((t) => t.name === 'get_ingest_status')!;

    const fakeMp3 = path.join(tmpDir, 'giveup-test.mp3');
    const { job_id } = (await ingestTool.handler({ uri: fakeMp3 })) as { job_id: string };

    // Poll 10 times
    let lastResult: { should_give_up: boolean; retry_after_ms: number } | null = null;
    for (let i = 0; i < 10; i++) {
      lastResult = (await statusTool.handler({ job_id })) as { should_give_up: boolean; retry_after_ms: number };
    }

    expect(lastResult!.should_give_up).toBe(true);
    // After 10 polls (poll_count=10), retry_after_ms should be capped at 10000
    expect(lastResult!.retry_after_ms).toBe(10_000);
  });

  // ── delete_type confirm_required ──────────────────────────────────────────────
  it('delete_type: returns confirm_required with type_summary when confirm is false', async () => {
    const createTypeTool = tools.find((t) => t.name === 'create_type')!;
    const deleteTypeTool = tools.find((t) => t.name === 'delete_type')!;

    await createTypeTool.handler({ name: 'del_test_type', display_name: 'Del Test' });

    const result = (await deleteTypeTool.handler({
      name: 'del_test_type',
      confirm: false,
    })) as { error: string; type_summary: { type_name: string; memory_count: number } };

    expect(result.error).toBe('confirm_required');
    expect(result.type_summary.type_name).toBe('del_test_type');
    expect(typeof result.type_summary.memory_count).toBe('number');
  });

  // ── tool count ────────────────────────────────────────────────────────────────
  it('buildPublicTools returns exactly 24 tools', () => {
    expect(tools.length).toBe(24);
  });

  it('all 24 expected tools are present', () => {
    const names = new Set(tools.map((t) => t.name));
    const expected = [
      'remember', 'recall', 'get', 'update', 'forget', 'relate',
      'list_types', 'recent', 'ingest', 'get_ingest_status', 'suggest_properties',
      'watch', 'unwatch', 'list_sources',
      'create_type', 'delete_type',
      'connect_drive', 'list_drive_files',
      'connect_notion', 'list_notion_pages',
      'import_watch_later',
      'analyze_patterns', 'summarize_recent', 'find_gaps',
    ];
    for (const name of expected) {
      expect(names.has(name), `Missing tool: ${name}`).toBe(true);
    }
  });
});
