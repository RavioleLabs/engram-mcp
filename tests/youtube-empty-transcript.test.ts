// tests/youtube-empty-transcript.test.ts
// Regression: ingest() must fail (not complete with empty content) when YouTube
// transcript fetch returns empty segments / empty full_text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// vi.mock must be at top level so Vitest hoists it before imports.
vi.mock('../src/memory/modules/youtube/transcript-fetcher.js', () => ({
  fetchTranscript: vi.fn().mockResolvedValue({
    video_id: 'ZK3O402wf1c',
    title: 'Some Video',
    channel: 'Some Channel',
    language: 'en',
    segments: [],
    full_text: '',
  }),
  extractVideoId: vi.fn().mockReturnValue('ZK3O402wf1c'),
}));

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
  youtube: { preferLanguage: 'en', fallbackToYtdlp: false },
} as Parameters<typeof buildPublicTools>[1];

/** Poll get_ingest_status until non-pending. */
async function pollUntilDone(
  tools: ReturnType<typeof buildPublicTools>,
  jobId: string,
  timeoutMs = 15_000,
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
    if (result.status !== 'pending' && result.status !== 'processing') return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for job ${jobId}`);
}

describe('YouTube empty transcript handling', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-yt-empty-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingest of a youtube URL returns error or failed job — never a completed memory with empty content', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const ingestTool = tools.find((t) => t.name === 'ingest')!;

    const result = (await ingestTool.handler({
      uri: 'https://www.youtube.com/watch?v=ZK3O402wf1c',
    })) as { job_id?: string; status?: string; error?: string; id?: string };

    if (result.job_id) {
      // Async path — poll until done
      const finalStatus = await pollUntilDone(tools, result.job_id);
      // Must be failed, not completed
      expect(finalStatus.status).toBe('failed');
      expect(finalStatus.memory_id).toBeUndefined();
      expect(finalStatus.error).toBeTruthy();
    } else {
      // Sync path errored
      expect(result.error).toBeTruthy();
      expect(result.id).toBeUndefined();
    }
  }, 20_000);

  it('no youtube memory with empty content exists after failed ingest', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const ingestTool = tools.find((t) => t.name === 'ingest')!;

    const result = (await ingestTool.handler({
      uri: 'https://www.youtube.com/watch?v=ZK3O402wf1c',
    })) as { job_id?: string };

    if (result.job_id) {
      await pollUntilDone(tools, result.job_id);
    } else {
      // Sync path — small wait for any side effects
      await new Promise((r) => setTimeout(r, 200));
    }

    const { getDb } = await import('../src/db/index.js');
    const db = getDb();
    const emptyMemories = db
      .prepare(`SELECT id FROM memories WHERE type = 'youtube' AND content = ''`)
      .all();
    expect(emptyMemories).toHaveLength(0);
  }, 20_000);

  it('ingest with type=youtube and empty transcript returns {error} in sync path', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const ingestTool = tools.find((t) => t.name === 'ingest')!;

    // With forceType='youtube', the fast-path heuristic routes to either sync or async.
    // Either way, the result must NOT have a completed memory with empty content.
    const result = (await ingestTool.handler({
      uri: 'https://www.youtube.com/watch?v=ZK3O402wf1c',
      type: 'youtube',
    })) as { job_id?: string; error?: string; id?: string; status?: string };

    if (result.job_id) {
      const finalStatus = await pollUntilDone(tools, result.job_id);
      expect(finalStatus.status).toBe('failed');
    } else if (result.status === 'completed') {
      // If somehow completed, there must NOT be empty content
      const { getDb } = await import('../src/db/index.js');
      const db = getDb();
      const mem = db
        .prepare(`SELECT content FROM memories WHERE id = ?`)
        .get(result.id as string) as { content: string } | undefined;
      expect(mem?.content).toBeTruthy();
    } else {
      // Error response
      expect(result.error).toBeTruthy();
    }
  }, 20_000);
});
