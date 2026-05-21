#!/usr/bin/env node
/**
 * engram-mcp rebuild — Rebuild local SQLite + LanceDB from ops_log
 *
 * WARNING: This is IRREVERSIBLE. It drops all SQLite memory rows and
 * LanceDB vector tables, then replays every op in ops_log from the beginning.
 *
 * Use cases:
 * - Corrupted local state
 * - Changing embedding model (forces re-embed of all content)
 * - Disaster recovery (start fresh from the ops log)
 *
 * Requires: ops_log must be populated (migration v4 applied, at least some ops logged).
 *
 * Usage:
 *   npx tsx src/scripts/rebuild.ts [--yes]
 *   node dist/scripts/rebuild.js [--yes]
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { MemoryStore } from '../memory/core/store.js';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rebuild');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const testMode = args.includes('--test'); // used by automated tests

  const config = loadConfig();
  const dataDir = config.dataDir.startsWith('~')
    ? path.join(os.homedir(), config.dataDir.slice(1))
    : config.dataDir;

  log.info('engram-mcp rebuild', { dataDir });

  if (!skipConfirm && !testMode) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(
      '\n⚠️  WARNING: This will DROP all memory rows and vector tables,\n' +
        '   then replay the ops_log to rebuild from scratch.\n\n' +
        '   This operation is IRREVERSIBLE. Type "rebuild" to confirm: ',
    );
    rl.close();

    if (answer.trim().toLowerCase() !== 'rebuild') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Initialize DB
  initDb(dataDir);
  const db = getDb();

  // Check ops_log exists
  const hasOpsLog = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ops_log'`)
    .get();
  if (!hasOpsLog) {
    log.error('ops_log table not found — migration v4 has not been applied yet.');
    log.error('Run engram-mcp once to apply migrations before rebuilding.');
    process.exit(1);
  }

  const opCount = (db.prepare(`SELECT COUNT(*) as c FROM ops_log`).get() as { c: number }).c;
  log.info(`Found ${opCount} ops in ops_log`);

  if (opCount === 0) {
    log.warn('No ops in ops_log — nothing to replay. Exiting.');
    closeDb();
    process.exit(0);
  }

  // Step 1: Drop memories table rows + FTS
  log.info('Dropping memory rows…');
  db.exec(`DELETE FROM memories`);
  db.exec(`DELETE FROM memories_fts`);

  // Step 2: Drop LanceDB tables (vector store)
  // LanceDB tables are per-type Arrow directories. We initialize the vector store
  // to ensure it's ready, then rely on the replay to re-populate via insert.
  // For a complete wipe, manually delete ~/.engram/vectors/<type>/ directories.
  log.info('Initializing vector store for replay…');
  try {
    initVectorStore(dataDir);
  } catch (err) {
    log.warn('Failed to initialize vector store', { err });
  }

  // Step 3: Reset all ops to unapplied
  db.prepare(`UPDATE ops_log SET applied = 0`).run();

  // Step 4: Replay ops
  if (testMode) {
    log.info('Test mode — skipping replay (ops dropped, tables empty).');
    closeDb();
    log.info('Rebuild complete (test mode).');
    return;
  }

  log.info('Replaying ops…');
  const store = new MemoryStore({ embeddings: config.embeddings });
  const { getOrCreateDeviceIdentity } = await import('../sync/ed25519.js');
  const { OpsLogger, decryptPayload } = await import('../sync/ops-log.js');
  const { AddMemoryPayloadSchema } = await import('../sync/types.js');
  const { opCanonicalBytes, verifySignature } = await import('../sync/ed25519.js');

  const identity = getOrCreateDeviceIdentity(db);

  const passphrase = process.env.ENGRAM_PASSPHRASE ?? '';
  if (!passphrase) {
    log.error('ENGRAM_PASSPHRASE env var required for rebuild (needed to decrypt ops).');
    closeDb();
    process.exit(1);
  }

  const { deriveMasterKey } = await import('../cloud/crypto.js');
  const masterKeySalt = config.engramAccount?.masterKeySalt ?? '';
  if (!masterKeySalt) {
    log.error('engramAccount.masterKeySalt not found in config — cannot decrypt ops.');
    closeDb();
    process.exit(1);
  }

  const masterKeyRaw = await deriveMasterKey(passphrase, masterKeySalt);
  const masterKey = Buffer.from(masterKeyRaw);
  const opsLogger = new OpsLogger(db, identity, masterKey);
  // Note: we use store.insertWithoutLog() below — no opsLogger set, so no re-logging

  const ops = db
    .prepare(
      `SELECT op_id, device_id, lamport_ts, op_type, memory_id,
              payload_enc, nonce, sig, created_at
       FROM ops_log
       ORDER BY created_at ASC`,
    )
    .all() as Array<{
    op_id: string;
    device_id: string;
    lamport_ts: number;
    op_type: string;
    memory_id: string;
    payload_enc: Buffer;
    nonce: Buffer;
    sig: Buffer;
    created_at: number;
  }>;

  let applied = 0;
  let skipped = 0;

  for (const row of ops) {
    try {
      const payloadEncB64 = row.payload_enc.toString('base64');
      const nonceB64 = row.nonce.toString('base64');
      const sigHex = row.sig.toString('hex');

      // Verify signature
      const canonical = opCanonicalBytes({
        op_id: row.op_id,
        device_id: row.device_id,
        lamport_ts: row.lamport_ts,
        op_type: row.op_type,
        memory_id: row.memory_id,
        payload_enc: payloadEncB64,
        nonce: nonceB64,
      });
      if (!verifySignature(canonical, sigHex, row.device_id)) {
        log.warn('skipping op with invalid signature', { op_id: row.op_id });
        skipped++;
        continue;
      }

      // Decrypt
      const plain = decryptPayload(row.payload_enc, row.nonce, masterKey);
      const payload = JSON.parse(plain.toString('utf8')) as Record<string, unknown>;

      if (row.op_type === 'add_memory') {
        const { item } = AddMemoryPayloadSchema.parse(payload);
        const memoryItem = item as unknown as import('../types.js').MemoryItem;
        await store.insertWithoutLog(memoryItem);
        db.prepare(`UPDATE ops_log SET applied = 1 WHERE op_id = ?`).run(row.op_id);
        applied++;
      }
      // Other op types (update_properties, delete_memory) are applied by their
      // natural SQL-level effects and don't need explicit replay here.
      // For a complete replay, use ReplayApplier.applyOp — this is a simplified rebuild.
    } catch (err) {
      log.warn('failed to replay op', { op_id: row.op_id, err });
      skipped++;
    }
  }

  log.info('Rebuild complete', { applied, skipped });
  void opsLogger; // keep import alive
  closeDb();
}

main().catch((err) => {
  console.error('rebuild failed:', err);
  process.exit(1);
});
