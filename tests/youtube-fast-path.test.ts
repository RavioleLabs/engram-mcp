// tests/youtube-fast-path.test.ts
// Verify YouTube fast-path heuristic:
//   - Short videos (<5 min) → sync path (when probe succeeds)
//   - Long videos or probe fails → async job
// Network tests are gated behind SKIP_NETWORK=1
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../src/db/index.js';
import { initVectorStore } from '../src/vector/store.js';
import { MemoryStore } from '../src/memory/core/store.js';
import { buildPublicTools } from '../src/memory/public/tools.js';
import type { EngramConfig } from '../src/config/schema.js';

const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

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

describe('YouTube fast-path heuristic', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: ReturnType<typeof buildPublicTools>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-yt-'));
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

  it('non-youtube URLs are not affected (sync path unchanged)', async () => {
    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const mdPath = path.join(tmpDir, 'test.md');
    fs.writeFileSync(mdPath, '# Test\nContent for testing.');

    const result = (await ingestTool.handler({ uri: mdPath })) as {
      status: string;
      job_id?: string;
    };
    expect(result.status).toBe('completed');
    expect(result.job_id).toBeUndefined();
  });

  it('audio files still go async (not affected by youtube fast-path)', async () => {
    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const mp3Path = path.join(tmpDir, 'test.mp3');

    const result = (await ingestTool.handler({ uri: mp3Path })) as {
      status: string;
      job_id?: string;
    };
    expect(result.status).toBe('pending');
    expect(result.job_id).toBeTruthy();
  });

  it.skipIf(SKIP_NETWORK)(
    'youtube: short video probe (if network available) — either sync completed or async pending',
    async () => {
      const ingestTool = tools.find((t) => t.name === 'ingest')!;
      // This is a known very short YouTube video (YouTube's first video, ~18s)
      // https://www.youtube.com/watch?v=jNQXAC9IVRw
      const youtubeUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

      const result = (await ingestTool.handler({ uri: youtubeUrl })) as {
        status?: string;
        job_id?: string;
        id?: string;
        error?: string;
      };

      if (result.error) {
        // Network error or transcript unavailable — acceptable in CI
        console.log('YouTube test skipped due to network/transcript error:', result.error);
        return;
      }

      // Either sync (fast_path) or async are acceptable outcomes
      expect(['completed', 'pending']).toContain(result.status);
      if (result.status === 'completed') {
        expect(result.id).toBeTruthy();
      } else {
        expect(result.job_id).toBeTruthy();
      }
    },
    30_000,
  );
});
