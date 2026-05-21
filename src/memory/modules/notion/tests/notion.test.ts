import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb, getDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { isNotionConnected, getNotionToken } from '../oauth.js';
import { buildNotionItem } from '../ingest.js';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

describe('notion module integration (token + ingest)', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-notion-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores OAuth tokens via direct DB write and reads them back', () => {
    getDb()
      .prepare(
        `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, extra_json, updated_at)
         VALUES ('notion', 'secret_xyz', NULL, NULL, '{"workspace_id":"w1","workspace_name":"MyOrg","bot_id":"b1"}', ?)`,
      )
      .run(Date.now());
    expect(isNotionConnected()).toBe(true);
    expect(getNotionToken()).toBe('secret_xyz');
  });

  it('buildNotionItem + insert + search', async () => {
    const item = buildNotionItem({
      metadata: {
        id: 'page-1',
        title: 'Engineering Standards',
        last_edited_time: '2026-05-15T10:00:00Z',
        url: 'https://www.notion.so/Engineering-Standards-page-1',
      },
      content: 'Use TypeScript strict mode. Use ULIDs. Avoid `any` type.',
      embeddingModel: 'nomic-embed-text:v1.5',
    });
    await store.insert(item);
    const hits = await store.search('notion', 'TypeScript guidelines', 5);
    expect(hits[0].memory.id).toBe(item.id);
  });
});
