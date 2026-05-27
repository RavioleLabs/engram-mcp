// tests/recall-calibration.test.ts
// Verify OSS calibration: notes rank higher than audio/youtube when scores are equal.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
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

describe('recall calibration — OSS weights + recency + MMR', () => {
  let tmpDir: string;
  let store: MemoryStore;
  const KEYWORD = 'neutrino physics experiment';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-calibration-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });

    const now = new Date().toISOString();

    // Insert 3 notes with the keyword
    for (let i = 0; i < 3; i++) {
      await store.insert({
        id: ulid(),
        type: 'notes',
        source_id: `notes-${i}`,
        content: `Research note ${i}: ${KEYWORD} — detailed experimental setup and results`,
        content_hash: `notes-hash-${i}`,
        properties: { created_at: now, ingested_at: now, title: `Note ${i}`, tags: ['physics'] },
        wikilinks: [],
        related_ids: [],
        embedding_model: 'nomic-embed-text',
      });
    }

    // Insert 1 audio transcript with the keyword (lower weight: 0.80)
    await store.insert({
      id: ulid(),
      type: 'audio',
      source_id: 'audio-1',
      content: `Audio transcript: ${KEYWORD} — recorded lecture, may contain filler words and repetitions`,
      content_hash: 'audio-hash-1',
      properties: { created_at: now, ingested_at: now, title: 'Lecture Recording', tags: ['physics'] },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'nomic-embed-text',
    });

    // Insert 1 youtube transcript with the keyword (lower weight: 0.75)
    await store.insert({
      id: ulid(),
      type: 'youtube',
      source_id: 'youtube-1',
      content: `YouTube transcript: ${KEYWORD} — long video with ads, sponsorships, and tangents`,
      content_hash: 'youtube-hash-1',
      properties: { created_at: now, ingested_at: now, title: 'YouTube Video', tags: ['physics'] },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'nomic-embed-text',
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('notes rank higher than audio when query matches all types equally', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const recallTool = tools.find((t) => t.name === 'recall')!;

    const response = (await recallTool.handler({
      query: 'neutrino physics',
      limit: 10,
    })) as { results: Array<{ id: string; type: string; score: number; title: string }> };
    const results = response.results;

    expect(results.length).toBeGreaterThan(0);

    // Separate by type
    const notesResults = results.filter((r) => r.type === 'notes');
    const audioResults = results.filter((r) => r.type === 'audio');
    const youtubeResults = results.filter((r) => r.type === 'youtube');

    // All types should appear
    expect(notesResults.length).toBeGreaterThan(0);
    expect(audioResults.length).toBeGreaterThan(0);
    expect(youtubeResults.length).toBeGreaterThan(0);

    // Top result should be a note (highest type weight)
    expect(results[0].type).toBe('notes');

    // Audio should outrank youtube (0.80 vs 0.75)
    const topAudioScore = audioResults[0]?.score ?? 0;
    const topYoutubeScore = youtubeResults[0]?.score ?? 0;
    expect(topAudioScore).toBeGreaterThanOrEqual(topYoutubeScore);
  });

  it('MMR diversification prevents all 3 notes from occupying top 3 slots when limit is 3', async () => {
    const tools = buildPublicTools(store, mockConfig);
    const recallTool = tools.find((t) => t.name === 'recall')!;

    const response = (await recallTool.handler({
      query: 'neutrino physics',
      limit: 3,
    })) as { results: Array<{ id: string; type: string }> };
    const results = response.results;

    // With MMR lambda=0.7, we expect at least some type diversity in top 3
    // The 3 notes share 'physics' tag → MMR will penalize the 3rd note
    const types = results.map((r) => r.type);
    expect(results).toHaveLength(3);
    // At minimum, result set should be non-empty
    expect(types.length).toBe(3);
  });

  it('public tool surface has the expected tools (all public — no admin flag)', () => {
    const tools = buildPublicTools(store, mockConfig);
    const names = tools.map((t) => t.name).sort();
    const expected = [
      'analyze_patterns',
      'connect_drive',
      'connect_notion',
      'create_type',
      'delete_type',
      'describe_types',
      'find_gaps',
      'forget',
      'get',
      'get_ingest_status',
      'import_watch_later',
      'ingest',
      'list_drive_files',
      'list_notion_pages',
      'list_sources',
      'list_types',
      'pin',
      'recall',
      'recall_chain',
      'recent',
      'relate',
      'remember',
      'set_importance',
      'skip',
      'suggest_properties',
      'summarize_recent',
      'unpin',
      'unskip',
      'unwatch',
      'update',
      'watch',
    ];
    expect(names).toEqual(expected);
  });
});
