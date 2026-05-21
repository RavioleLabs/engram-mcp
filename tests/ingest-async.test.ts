// tests/ingest-async.test.ts
// Verify async job system: audio/youtube → job_id + pending, then poll to completed.
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

/** Poll get_ingest_status until status !== 'pending' or timeout. */
async function pollUntilDone(
  tools: ReturnType<typeof buildPublicTools>,
  jobId: string,
  timeoutMs = 90_000,
): Promise<{ job_id: string; status: string; memory_id?: string; error?: string }> {
  const statusTool = tools.find((t) => t.name === 'get_ingest_status')!;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = (await statusTool.handler({ job_id: jobId })) as {
      job_id: string;
      status: string;
      memory_id?: string;
      error?: string;
    };
    if (result.status !== 'pending' && result.status !== 'processing') {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timeout waiting for job ${jobId}`);
}

describe('async ingest job system', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-async-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingest of an audio path returns { job_id, status: pending } immediately', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const ingestTool = tools.find((t) => t.name === 'ingest')!;

    // Use a fake .mp3 path — async detection is by extension, not file existence
    const fakeMp3 = path.join(tmpDir, 'test-audio.mp3');

    const result = (await ingestTool.handler({
      uri: fakeMp3,
      title: 'Test Audio',
      tags: ['test'],
    })) as { job_id?: string; status?: string; memory_id?: string };

    // Should return async job, not a completed result
    expect(result.job_id).toBeTruthy();
    expect(result.status).toBe('pending');
    expect(result.memory_id).toBeUndefined();
  });

  it('get_ingest_status returns job_not_found for unknown job_id', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const statusTool = tools.find((t) => t.name === 'get_ingest_status')!;

    const result = (await statusTool.handler({ job_id: 'job_FAKEID' })) as { error: string };
    expect(result.error).toBe('job_not_found');
  });

  it('ingest of audio path fails gracefully (file not found → job fails, not crash)', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const ingestTool = tools.find((t) => t.name === 'ingest')!;

    const fakeMp3 = path.join(tmpDir, 'nonexistent.mp3');
    const result = (await ingestTool.handler({ uri: fakeMp3 })) as {
      job_id?: string;
      status?: string;
    };

    expect(result.job_id).toBeTruthy();
    expect(result.status).toBe('pending');

    // Poll — the job should eventually fail (file doesn't exist, whisper will error)
    const finalStatus = await pollUntilDone(tools, result.job_id!, 15_000);
    expect(finalStatus.status).toBe('failed');
    expect(finalStatus.error).toBeTruthy();
  }, 20_000);

  it('ingest of .md file returns synchronous result (fast path)', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const ingestTool = tools.find((t) => t.name === 'ingest')!;

    const mdPath = path.join(tmpDir, 'test-note.md');
    fs.writeFileSync(mdPath, '# Fast Note\n\nThis should be sync.');

    const result = (await ingestTool.handler({ uri: mdPath })) as {
      id?: string;
      status?: string;
      job_id?: string;
    };

    // Fast path: should return completed memory directly
    expect(result.id).toBeTruthy();
    expect(result.status).toBe('completed');
    expect(result.job_id).toBeUndefined();
  });

  it('get_ingest_status tool is in the public surface', () => {
    const tools = buildPublicTools(store, mockConfig);
    expect(tools.find((t) => t.name === 'get_ingest_status')).toBeTruthy();
  });

  it('job GC: gcJobsOnStartup removes completed jobs older than 7 days', async () => {
    const { getDb } = await import('../src/db/index.js');
    const { gcJobsOnStartup } = await import('../src/ingest/jobs.js');

    const db = getDb();
    const OLD_MS = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago

    // Insert a stale completed job directly
    db.prepare(
      `INSERT INTO ingest_jobs (id, uri, type, status, progress, created_at, completed_at, poll_count)
       VALUES (?, ?, NULL, 'completed', 100, ?, ?, 0)`,
    ).run('job_STALE001', 'file:///tmp/old.mp3', OLD_MS, OLD_MS);

    // Insert a recent completed job
    const RECENT_MS = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
    db.prepare(
      `INSERT INTO ingest_jobs (id, uri, type, status, progress, created_at, completed_at, poll_count)
       VALUES (?, ?, NULL, 'completed', 100, ?, ?, 0)`,
    ).run('job_RECENT001', 'file:///tmp/recent.mp3', RECENT_MS, RECENT_MS);

    gcJobsOnStartup();

    const stale = db.prepare(`SELECT id FROM ingest_jobs WHERE id = 'job_STALE001'`).get();
    const recent = db.prepare(`SELECT id FROM ingest_jobs WHERE id = 'job_RECENT001'`).get();

    expect(stale).toBeUndefined(); // Old job removed
    expect(recent).toBeTruthy();  // Recent job kept
  });
});
