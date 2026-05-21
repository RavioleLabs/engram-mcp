import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, getDb, closeDb } from '../db/index.js';

describe('db migrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'));
    initDb(tmpDir);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the memories table', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get();
    expect(row).toBeDefined();
  });

  it('creates the FTS5 table', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();
    expect(row).toBeDefined();
  });

  it('records schema version up to latest', () => {
    const row = getDb()
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number };
    expect(row.v).toBe(7); // v7 adds poll_count to ingest_jobs for exponential backoff hints
  });

  it('creates the ops_log + tombstones + device_identity tables at v4', () => {
    const opsLog = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_log'")
      .get();
    const tombstones = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tombstones'")
      .get();
    const deviceIdentity = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_identity'")
      .get();
    expect(opsLog).toBeDefined();
    expect(tombstones).toBeDefined();
    expect(deviceIdentity).toBeDefined();
  });

  it('creates the watched_sources table at v2', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='watched_sources'")
      .get();
    expect(row).toBeDefined();
  });

  it('creates the saved_views and settings tables at v3', () => {
    const views = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_views'")
      .get();
    const settings = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
      .get();
    expect(views).toBeDefined();
    expect(settings).toBeDefined();
  });

  it('creates the recovery_shards + snapshot_log tables at v5', () => {
    const shards = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_shards'")
      .get();
    const snapLog = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshot_log'")
      .get();
    expect(shards).toBeDefined();
    expect(snapLog).toBeDefined();
  });
});
