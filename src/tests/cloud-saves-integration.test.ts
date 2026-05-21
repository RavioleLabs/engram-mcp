// src/tests/cloud-saves-integration.test.ts
/**
 * Integration test: simulates PC1 taking a snapshot and PC2 bootstrapping from it.
 *
 * Requires:
 *   - Local wrangler dev running at ENGRAM_CLOUD_URL (default: http://localhost:8787)
 *   - A valid test JWT in env: ENGRAM_TEST_JWT
 *   - The D1 migration 003-cloud-saves.sql applied: wrangler d1 execute --local --file=schema/003-cloud-saves.sql
 *
 * Run:
 *   ENGRAM_TEST_JWT=<token> npx vitest run src/tests/cloud-saves-integration.test.ts
 *
 * Skip (no JWT provided): tests are automatically skipped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb, getDb } from '../db/index.js';
import { initCloudSaves, takeSnapshot, bootstrapFromSnapshot, encryptBuffer, decryptBuffer } from '../sync/cloud-saves.js';

const CLOUD_URL = process.env.ENGRAM_CLOUD_URL ?? 'http://localhost:8787';
const JWT = process.env.ENGRAM_TEST_JWT ?? '';
const MASTER_KEY = Buffer.alloc(32, 0xab); // test key — never use in production

const skip = !JWT;

describe('Encrypt/Decrypt round-trip (libsodium secretstream)', () => {
  it('encrypts and decrypts a buffer correctly', async () => {
    const plain = Buffer.from('Hello Engram snapshot world! This is a test of the secretstream.');
    const key = Buffer.alloc(32, 0xcd); // test key
    const encrypted = await encryptBuffer(plain, key);
    const decrypted = await decryptBuffer(encrypted, key);
    expect(decrypted).toStrictEqual(plain);
  });

  it('fails to decrypt with wrong key', async () => {
    const plain = Buffer.from('Secret data');
    const key = Buffer.alloc(32, 0xaa);
    const wrongKey = Buffer.alloc(32, 0xbb);
    const encrypted = await encryptBuffer(plain, key);
    await expect(decryptBuffer(encrypted, wrongKey)).rejects.toThrow(/decryption failed/);
  });
});

describe.skipIf(skip)('Cloud Saves integration (PC1 → snapshot → PC2 bootstrap)', () => {
  let pc1Dir: string;
  let pc2Dir: string;

  afterEach(() => {
    try {
      closeDb();
    } catch {
      // May already be closed
    }
    if (pc1Dir) fs.rmSync(pc1Dir, { recursive: true, force: true });
    if (pc2Dir) fs.rmSync(pc2Dir, { recursive: true, force: true });
  });

  it('PC1 snapshot is downloadable and restores DB on PC2', async () => {
    // PC1 setup
    pc1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pc1-'));
    pc2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pc2-'));

    process.env.DATA_DIR = pc1Dir;
    initDb(pc1Dir);

    const db = getDb();
    // Insert some test memories
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, type, source_id, content, content_hash, properties_json, wikilinks_json, related_ids_json, embedding_model, created_at)
       VALUES (?, 'notes', 's1', 'Hello from PC1', 'hash1', '{}', '[]', '[]', 'test', ?)`,
    ).run('mem_001', now);

    // PC1 takes a snapshot
    initCloudSaves({ masterKey: MASTER_KEY, jwt: JWT, cloudBaseUrl: CLOUD_URL });
    const { id: snapshotId, sizeBytes } = await takeSnapshot();
    expect(snapshotId).toBeTruthy();
    expect(sizeBytes).toBeGreaterThan(0);

    closeDb();

    // PC2 bootstrap
    const result = await bootstrapFromSnapshot({
      masterKey: MASTER_KEY,
      jwt: JWT,
      dataDir: pc2Dir,
      cloudBaseUrl: CLOUD_URL,
    });

    expect(result).not.toBeNull();
    expect(result!.sizeBytes).toBeGreaterThan(0);

    // PC2 opens the restored DB and finds PC1's memory
    process.env.DATA_DIR = pc2Dir;
    initDb(pc2Dir);
    const pc2Db = getDb();
    const row = pc2Db.prepare(`SELECT content FROM memories WHERE id = ?`).get('mem_001') as
      | { content: string }
      | undefined;

    expect(row).toBeDefined();
    expect(row!.content).toBe('Hello from PC1');

    closeDb();
  }, 60_000);
});
