// src/sync/cloud-saves.ts
/**
 * Cloud Saves — nightly encrypted snapshot of SQLite DB.
 *
 * Flow:
 *   1. Checkpoint SQLite WAL and copy the DB file to a temp location.
 *   2. Get the current Lamport timestamp from ops_log.
 *   3. Encrypt the DB bytes with libsodium secretstream (master key).
 *   4. PUT /saves/snapshot → engram-cloud (sends body).
 *   5. Record snapshot in local snapshot_log table.
 *   6. GC local temp files.
 *
 * Bootstrap (new PC):
 *   1. GET /saves/snapshot → list available snapshots.
 *   2. Download latest snapshot.
 *   3. Decrypt → restore SQLite.
 *   4. Fetch and replay ops_log deltas > snapshot lamport_ts (Plan N protocol).
 */

import sodium from 'libsodium-wrappers';
import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const log = createLogger('cloud-saves');

/** In-memory master key — set by the auth/pairing flow. */
let _masterKey: Buffer | null = null;
let _jwt: string | null = null;
let _cloudBaseUrl: string = 'https://api.engram-mcp.com';

export function initCloudSaves(params: {
  masterKey: Buffer;
  jwt: string;
  cloudBaseUrl?: string;
}): void {
  _masterKey = params.masterKey;
  _jwt = params.jwt;
  if (params.cloudBaseUrl) _cloudBaseUrl = params.cloudBaseUrl;
  log.info('Cloud Saves module initialized');
}

export function clearCloudSaves(): void {
  if (_masterKey) _masterKey.fill(0);
  _masterKey = null;
  _jwt = null;
}

/** Schedule the nightly snapshot at 03:00 local time. */
export function scheduleNightlySnapshot(): NodeJS.Timeout {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  const msUntilFirst = next.getTime() - now.getTime();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  log.info(
    `Nightly snapshot scheduled in ${Math.round(msUntilFirst / 60000)} minutes (03:00 local)`,
  );

  const timeout = setTimeout(async () => {
    await takeSnapshot().catch((err) =>
      log.error(`Nightly snapshot failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    setInterval(async () => {
      await takeSnapshot().catch((err) =>
        log.error(`Nightly snapshot failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, TWENTY_FOUR_HOURS);
  }, msUntilFirst);

  return timeout;
}

/**
 * Take a snapshot now. Can be called manually (e.g., from a dashboard button).
 */
export async function takeSnapshot(): Promise<{ id: string; sizeBytes: number }> {
  if (!_masterKey || !_jwt) {
    throw new Error('Cloud Saves not initialized — call initCloudSaves() first');
  }

  const config = loadConfig();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-snap-'));

  try {
    // 1. Checkpoint SQLite WAL and copy the DB file
    const db = getDb();
    db.pragma('wal_checkpoint(FULL)');
    const dbPath = path.join(config.dataDir, 'engram.db');
    const dbCopyPath = path.join(tmpDir, 'engram.db');
    fs.copyFileSync(dbPath, dbCopyPath);
    log.info(`DB copied to ${dbCopyPath}`);

    // 2. Get current Lamport timestamp from ops_log
    const lamportRow = db.prepare(`SELECT MAX(lamport_ts) as max_ts FROM ops_log`).get() as
      | { max_ts: number | null }
      | undefined;
    const lamportTs = lamportRow?.max_ts ?? 0;

    // 3. Read DB bytes
    const dbBytes = fs.readFileSync(dbCopyPath);

    // 4. Encrypt with libsodium secretstream
    const encryptedBytes = await encryptBuffer(dbBytes, _masterKey);
    log.info(`Snapshot encrypted: ${encryptedBytes.byteLength} bytes`);

    // 5. Upload
    const res = await fetch(`${_cloudBaseUrl}/saves/snapshot`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(encryptedBytes.byteLength),
        Authorization: `Bearer ${_jwt}`,
        'X-Lamport-Ts': String(lamportTs),
      },
      body: encryptedBytes,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Snapshot upload failed: ${res.status} — ${body}`);
    }

    const result = (await res.json()) as { id: string; r2_key: string };
    const snapshotId = result.id;

    // 6. Record in local snapshot_log
    db.prepare(
      `INSERT INTO snapshot_log (id, r2_key, lamport_ts, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(snapshotId, result.r2_key, lamportTs, encryptedBytes.byteLength, Date.now());

    log.info(`Snapshot complete: id=${snapshotId}, size=${encryptedBytes.byteLength} bytes`);
    return { id: snapshotId, sizeBytes: encryptedBytes.byteLength };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Bootstrap a new PC from the latest cloud snapshot.
 * Decrypts the snapshot and restores the SQLite DB in-place.
 * After this, the caller should replay ops_log deltas > lamportTs from the cloud relay.
 */
export async function bootstrapFromSnapshot(params: {
  masterKey: Buffer;
  jwt: string;
  dataDir: string;
  cloudBaseUrl?: string;
}): Promise<{ lamportTs: number; sizeBytes: number } | null> {
  const base = params.cloudBaseUrl ?? 'https://api.engram-mcp.com';

  // List snapshots
  const listRes = await fetch(`${base}/saves/snapshot`, {
    headers: { Authorization: `Bearer ${params.jwt}` },
  });
  if (!listRes.ok) throw new Error(`Snapshot list failed: ${listRes.status}`);

  const { snapshots } = (await listRes.json()) as {
    snapshots: Array<{ id: string; lamport_ts: number; size_bytes: number; available: boolean }>;
  };

  if (!snapshots || snapshots.length === 0) {
    log.info('No cloud snapshots found — fresh start');
    return null;
  }

  const latest = snapshots[0]; // already ordered DESC by created_at
  if (!latest.available) {
    log.warn('Latest snapshot marked unavailable in R2');
    return null;
  }

  log.info(`Bootstrapping from snapshot ${latest.id} (lamport_ts=${latest.lamport_ts})`);

  // Download
  const dlRes = await fetch(`${base}/saves/snapshot/${latest.id}/download`, {
    headers: { Authorization: `Bearer ${params.jwt}` },
  });
  if (!dlRes.ok) throw new Error(`Snapshot download failed: ${dlRes.status}`);

  const encryptedBytes = Buffer.from(await dlRes.arrayBuffer());

  // Decrypt
  const plainBytes = await decryptBuffer(encryptedBytes, params.masterKey);

  // Restore: write to a temp file then atomically move to dataDir/engram.db
  const tmpPath = path.join(os.tmpdir(), `engram-restore-${Date.now()}.db`);
  fs.writeFileSync(tmpPath, plainBytes);

  const dbTarget = path.join(params.dataDir, 'engram.db');
  if (fs.existsSync(dbTarget)) {
    fs.copyFileSync(dbTarget, `${dbTarget}.bak-${Date.now()}`);
  }
  fs.renameSync(tmpPath, dbTarget);

  log.info(`DB restored from snapshot. Replay ops > lamport_ts=${latest.lamport_ts}`);

  return { lamportTs: latest.lamport_ts, sizeBytes: encryptedBytes.byteLength };
}

// ---------------------------------------------------------------------------
// Encryption helpers (libsodium secretstream)
// ---------------------------------------------------------------------------

export async function encryptBuffer(plain: Buffer, key: Buffer): Promise<Buffer> {
  await sodium.ready;

  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(
    new Uint8Array(key),
  );

  const cipherChunk = sodium.crypto_secretstream_xchacha20poly1305_push(
    state,
    new Uint8Array(plain),
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
  );

  // Format: header || ciphertext
  return Buffer.concat([Buffer.from(header), Buffer.from(cipherChunk)]);
}

export async function decryptBuffer(encrypted: Buffer, key: Buffer): Promise<Buffer> {
  await sodium.ready;

  const HEADER_LEN = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  const header = encrypted.subarray(0, HEADER_LEN);
  const cipher = encrypted.subarray(HEADER_LEN);

  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
    new Uint8Array(header),
    new Uint8Array(key),
  );

  const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
    state,
    new Uint8Array(cipher),
    null,
  );
  if (!result) throw new Error('Snapshot decryption failed — wrong key or corrupted data');

  return Buffer.from(result.message);
}
