import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../db/index.js';
import { sourceRegistry } from '../memory/core/source-registry.js';

describe('SourceRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sr-'));
    initDb(tmpDir);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds and lists a watched source', () => {
    const id = sourceRegistry.add({
      module_id: 'drive',
      external_id: 'doc-123',
      display_name: 'Q1 Roadmap',
    });
    const sources = sourceRegistry.list('drive');
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(id);
    expect(sources[0].display_name).toBe('Q1 Roadmap');
  });

  it('records sync timestamp and last_modified_remote', () => {
    const id = sourceRegistry.add({
      module_id: 'notion',
      external_id: 'page-456',
      display_name: 'Engineering',
    });
    sourceRegistry.recordSync(id, '2026-05-15T10:00:00Z');
    const s = sourceRegistry.get(id);
    expect(s?.last_synced_at).toBeGreaterThan(0);
    expect(s?.last_modified_remote).toBe('2026-05-15T10:00:00Z');
  });

  it('add() is idempotent on (module_id, external_id) — returns existing id instead of throwing', () => {
    const id1 = sourceRegistry.add({ module_id: 'drive', external_id: 'd1', display_name: 'A' });
    const id2 = sourceRegistry.add({ module_id: 'drive', external_id: 'd1', display_name: 'A2' });
    // Should return the existing id, not throw
    expect(id2).toBe(id1);
    // Only one row should exist
    const sources = sourceRegistry.list('drive');
    expect(sources.filter((s) => s.external_id === 'd1')).toHaveLength(1);
  });

  it('removes a watched source', () => {
    const id = sourceRegistry.add({
      module_id: 'drive',
      external_id: 'd2',
      display_name: 'Z',
    });
    sourceRegistry.remove(id);
    expect(sourceRegistry.get(id)).toBeUndefined();
  });
});
