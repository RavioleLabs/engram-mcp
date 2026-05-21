// src/sync/tests/ops-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../db/index.js';
import { getOrCreateDeviceIdentity, verifySignature, opCanonicalBytes } from '../ed25519.js';
import { OpsLogger, encryptPayload, decryptPayload } from '../ops-log.js';

let tmpDir: string;
let db: Database.Database;
const masterKey = Buffer.alloc(32, 0x42); // test key

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'engram-ops-test-'));
  db = initDb(join(tmpDir, 'engram.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

describe('encryptPayload / decryptPayload', () => {
  it('roundtrips', () => {
    const plain = Buffer.from('{"hello":"world"}');
    const { enc, nonce } = encryptPayload(plain, masterKey);
    const dec = decryptPayload(enc, nonce, masterKey);
    expect(dec.toString()).toBe('{"hello":"world"}');
  });

  it('rejects wrong key', () => {
    const { enc, nonce } = encryptPayload(Buffer.from('test'), masterKey);
    const badKey = Buffer.alloc(32, 0xff);
    expect(() => decryptPayload(enc, nonce, badKey)).toThrow();
  });
});

describe('OpsLogger', () => {
  it('appends op and lists as pending', () => {
    const identity = getOrCreateDeviceIdentity(db);
    const logger = new OpsLogger(db, identity, masterKey);

    const opId = logger.append('add_memory', 'mem-123', { content: 'hello' });

    const pending = logger.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.op_id).toBe(opId);
    expect(pending[0]!.op_type).toBe('add_memory');
    expect(pending[0]!.memory_id).toBe('mem-123');
  });

  it('increments Lamport clock monotonically', () => {
    const identity = getOrCreateDeviceIdentity(db);
    const logger = new OpsLogger(db, identity, masterKey);

    const ids = Array.from({ length: 5 }, (_, i) =>
      logger.append('update_properties', `mem-${i}`, { tags: [`t${i}`] }),
    );

    const pending = logger.listPending();
    const lamports = pending.map((p) => p.lamport_ts);
    for (let i = 1; i < lamports.length; i++) {
      expect(lamports[i]!).toBeGreaterThan(lamports[i - 1]!);
    }
    expect(ids).toHaveLength(5);
  });

  it('markSent clears pending list', () => {
    const identity = getOrCreateDeviceIdentity(db);
    const logger = new OpsLogger(db, identity, masterKey);

    const opId = logger.append('delete_memory', 'mem-del', {});
    expect(logger.listPending()).toHaveLength(1);
    logger.markSent([opId]);
    expect(logger.listPending()).toHaveLength(0);
  });

  it('maxAppliedLamport returns 0 when nothing applied', () => {
    const identity = getOrCreateDeviceIdentity(db);
    const logger = new OpsLogger(db, identity, masterKey);
    expect(logger.maxAppliedLamport()).toBe(0);
  });

  it('sig field can be verified via ed25519', () => {
    const identity = getOrCreateDeviceIdentity(db);
    const logger = new OpsLogger(db, identity, masterKey);
    logger.append('add_memory', 'mem-sig-test', { content: 'sign test' });

    const pending = logger.listPending();
    const op = pending[0]!;
    const canonical = opCanonicalBytes({
      op_id: op.op_id,
      device_id: op.device_id,
      lamport_ts: op.lamport_ts,
      op_type: op.op_type,
      memory_id: op.memory_id,
      payload_enc: op.payload_enc,
      nonce: op.nonce,
    });
    expect(verifySignature(canonical, op.sig, identity.pubkey_hex)).toBe(true);
  });

  it('tampered payload fails signature verification', () => {
    const identity = getOrCreateDeviceIdentity(db);
    const logger = new OpsLogger(db, identity, masterKey);
    logger.append('add_memory', 'mem-tamper', { content: 'original' });

    const pending = logger.listPending();
    const op = pending[0]!;
    // Tamper payload_enc
    const tamperedOp = { ...op, payload_enc: 'AAAAAAAAAAAAAAAA' };
    const canonical = opCanonicalBytes({
      op_id: tamperedOp.op_id,
      device_id: tamperedOp.device_id,
      lamport_ts: tamperedOp.lamport_ts,
      op_type: tamperedOp.op_type,
      memory_id: tamperedOp.memory_id,
      payload_enc: tamperedOp.payload_enc,
      nonce: tamperedOp.nonce,
    });
    expect(verifySignature(canonical, op.sig, identity.pubkey_hex)).toBe(false);
  });
});
