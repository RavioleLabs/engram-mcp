import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb, getDb } from '../../../../db/index.js';
import { initVectorStore } from '../../../../vector/store.js';
import { MemoryStore } from '../../../core/store.js';
import { sourceRegistry } from '../../../core/source-registry.js';
import { buildDriveItem } from '../ingest.js';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

describe('drive module integration (token + registry + ingest)', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-drive-'));
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
         VALUES ('drive', 'fake', 'fakerefresh', ?, '{}', ?)`,
      )
      .run(Date.now() + 3_600_000, Date.now());
    const row = getDb()
      .prepare("SELECT access_token FROM oauth_tokens WHERE provider = 'drive'")
      .get() as { access_token: string } | undefined;
    expect(row?.access_token).toBe('fake');
  });

  it('buildDriveItem + insert + search round-trips', async () => {
    const item = buildDriveItem({
      metadata: {
        id: 'doc-123',
        name: 'Quarterly Roadmap',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-05-15T10:00:00Z',
      },
      content: 'The roadmap focuses on memory ingestion improvements and cloud transit hardening.',
      embeddingModel: 'nomic-embed-text:v1.5',
    });
    await store.insert(item);
    const hits = await store.search('drive', 'cloud transit', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].memory.id).toBe(item.id);
  });

  it('watcher records sync timestamps via sourceRegistry', () => {
    const id = sourceRegistry.add({
      module_id: 'drive',
      external_id: 'doc-X',
      display_name: 'X',
    });
    sourceRegistry.recordSync(id, '2026-05-15T11:00:00Z');
    const s = sourceRegistry.get(id);
    expect(s?.last_modified_remote).toBe('2026-05-15T11:00:00Z');
  });
});
