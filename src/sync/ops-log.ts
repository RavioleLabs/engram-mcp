// src/sync/ops-log.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { createLogger } from '../logger.js';
import { opCanonicalBytes, signBytes } from './ed25519.js';
import type { DeviceIdentity, OpType, WireOp } from './types.js';

const log = createLogger('sync:ops-log');
const ulid = monotonicFactory();

/** AES-256-GCM — NIST-approved, hardware-accelerated on most CPUs. */
const ALGO = 'aes-256-gcm' as const;

/**
 * Encrypt `plaintext` with a 256-bit master key.
 * Returns { enc: Buffer, nonce: Buffer } where nonce is 12 bytes (GCM standard).
 * The last 16 bytes of `enc` are the GCM auth tag.
 */
export function encryptPayload(
  plaintext: Buffer,
  masterKey: Buffer,
): { enc: Buffer; nonce: Buffer } {
  if (masterKey.length !== 32) throw new Error('masterKey must be 32 bytes');
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { enc, nonce };
}

/**
 * Decrypt an op payload.
 * The last 16 bytes of `enc` are the GCM auth tag.
 */
export function decryptPayload(enc: Buffer, nonce: Buffer, masterKey: Buffer): Buffer {
  if (masterKey.length !== 32) throw new Error('masterKey must be 32 bytes');
  const tag = enc.subarray(enc.length - 16);
  const ciphertext = enc.subarray(0, enc.length - 16);
  const decipher = createDecipheriv(ALGO, masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class OpsLogger {
  private db: Database.Database;
  private identity: DeviceIdentity;
  private masterKey: Buffer;

  constructor(db: Database.Database, identity: DeviceIdentity, masterKey: Buffer) {
    this.db = db;
    this.identity = identity;
    this.masterKey = masterKey;
  }

  /**
   * Append one operation to the ops_log.
   * - Increments the device Lamport clock.
   * - Encrypts the JSON payload with the master key (AES-256-GCM).
   * - Signs canonical bytes with the device private key.
   * - Inserts the row; does NOT set sent_at (pending push).
   * Returns the generated op_id (ULID).
   */
  append(opType: OpType, memoryId: string, payload: Record<string, unknown>): string {
    const opId = ulid();
    const createdAt = Date.now();

    // Lamport increment
    const lamportTs = this.#nextLamport();

    // Encrypt payload
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const { enc, nonce } = encryptPayload(plaintext, this.masterKey);
    const payloadEncB64 = enc.toString('base64');
    const nonceB64 = nonce.toString('base64');

    // Sign canonical bytes
    const canonical = opCanonicalBytes({
      op_id: opId,
      device_id: this.identity.device_id,
      lamport_ts: lamportTs,
      op_type: opType,
      memory_id: memoryId,
      payload_enc: payloadEncB64,
      nonce: nonceB64,
    });
    const sigHex = signBytes(canonical, this.identity.privkey_hex);

    // Persist — store raw bytes in BLOB columns
    this.db
      .prepare(
        `INSERT INTO ops_log
           (op_id, device_id, lamport_ts, op_type, memory_id,
            payload_enc, nonce, sig, applied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        opId,
        this.identity.device_id,
        lamportTs,
        opType,
        memoryId,
        enc, // raw encrypted bytes
        nonce, // raw nonce bytes
        Buffer.from(sigHex, 'hex'), // raw sig bytes
        createdAt,
      );

    log.debug('op appended', { opId, opType, memoryId, lamportTs });
    return opId;
  }

  /** Mark ops as sent (set sent_at = now). */
  markSent(opIds: string[]): void {
    if (opIds.length === 0) return;
    const now = Date.now();
    const placeholders = opIds.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE ops_log SET sent_at = ? WHERE op_id IN (${placeholders})`)
      .run(now, ...opIds);
  }

  /** Mark ops as applied locally. */
  markApplied(opIds: string[]): void {
    if (opIds.length === 0) return;
    const placeholders = opIds.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE ops_log SET applied = 1 WHERE op_id IN (${placeholders})`)
      .run(...opIds);
  }

  /** Return ops not yet sent to cloud (sent_at IS NULL). */
  listPending(): WireOp[] {
    const rows = this.db
      .prepare(
        `SELECT op_id, device_id, lamport_ts, op_type, memory_id,
                payload_enc, nonce, sig, created_at
         FROM ops_log
         WHERE sent_at IS NULL
         ORDER BY created_at ASC
         LIMIT 200`,
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

    return rows.map((r) => ({
      op_id: r.op_id,
      device_id: r.device_id,
      lamport_ts: r.lamport_ts,
      op_type: r.op_type as OpType,
      memory_id: r.memory_id,
      payload_enc: r.payload_enc.toString('base64'),
      nonce: r.nonce.toString('base64'),
      sig: r.sig.toString('hex'),
      created_at: r.created_at,
    }));
  }

  /** Return the max applied lamport_ts across all devices (for catch-up). */
  maxAppliedLamport(): number {
    const row = this.db
      .prepare(`SELECT MAX(lamport_ts) as m FROM ops_log WHERE applied = 1`)
      .get() as { m: number | null };
    return row.m ?? 0;
  }

  /** Return the lexicographically largest op_id that has been applied (any device). */
  maxAppliedOpId(): string | null {
    const row = this.db
      .prepare(`SELECT op_id FROM ops_log WHERE applied = 1 ORDER BY op_id DESC LIMIT 1`)
      .get() as { op_id: string } | undefined;
    return row?.op_id ?? null;
  }

  #nextLamport(): number {
    const row = this.db
      .prepare(`SELECT lamport_ts FROM device_identity WHERE device_id = ?`)
      .get(this.identity.device_id) as { lamport_ts: number };
    const next = (row?.lamport_ts ?? 0) + 1;
    this.db
      .prepare(`UPDATE device_identity SET lamport_ts = ? WHERE device_id = ?`)
      .run(next, this.identity.device_id);
    return next;
  }
}
