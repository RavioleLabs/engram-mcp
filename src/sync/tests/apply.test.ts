// src/sync/tests/apply.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { initDb } from '../../db/index.js';
import {
  getOrCreateDeviceIdentity,
  generateKeypair,
  opCanonicalBytes,
  signBytes,
} from '../ed25519.js';
import { encryptPayload } from '../ops-log.js';
import { ReplayApplier, lwwMergeProperties } from '../apply.js';
import type { WireOp } from '../types.js';
import type { MemoryStore } from '../../memory/core/store.js';

const ulid = monotonicFactory();
const masterKey = Buffer.alloc(32, 0x11);

describe('lwwMergeProperties', () => {
  it('incoming newer: scalars from incoming, arrays union', () => {
    const result = lwwMergeProperties(
      { title: 'old', tags: ['a', 'b'] },
      { title: 'new', tags: ['b', 'c'] },
      1,
      2,
    );
    expect(result.title).toBe('new');
    expect(result.tags).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect((result.tags as string[]).length).toBe(3);
  });

  it('current newer: scalars from current win, arrays still union', () => {
    const result = lwwMergeProperties(
      { title: 'current', tags: ['x'] },
      { title: 'stale', tags: ['y'] },
      10,
      5,
    );
    expect(result.title).toBe('current');
    expect(result.tags).toEqual(expect.arrayContaining(['x', 'y']));
  });
});

describe('ReplayApplier', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engram-apply-test-'));
    db = initDb(join(tmpDir, 'engram.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true });
  });

  it('skips ops from own device', async () => {
    const identity = getOrCreateDeviceIdentity(db);
    // Build a fake op attributed to this device
    const op: WireOp = buildFakeOp(
      identity.device_id,
      identity.privkey_hex,
      'add_memory',
      'mem-1',
      {
        item: { id: 'mem-1', type: 'notes', content: 'hi', content_hash: 'abc' },
      },
    );

    const applier = new ReplayApplier(db, {} as unknown as MemoryStore, masterKey);
    await applier.applyOp(op, identity.device_id); // should be no-op

    const row = db.prepare(`SELECT id FROM memories WHERE id = 'mem-1'`).get();
    expect(row).toBeUndefined();
  });

  it('rejects ops with invalid signature', async () => {
    const identity = getOrCreateDeviceIdentity(db);
    const other = generateKeypair();
    const op = buildFakeOp(other.pubkeyHex, other.privkeyHex, 'add_memory', 'mem-2', {
      item: { id: 'mem-2', type: 'notes', content: 'hi', content_hash: 'xyz' },
    });
    // Corrupt the sig
    const corruptOp = { ...op, sig: 'a'.repeat(128) };

    const applier = new ReplayApplier(db, {} as unknown as MemoryStore, masterKey);
    await applier.applyOp(corruptOp, identity.device_id); // should be rejected

    const row = db.prepare(`SELECT id FROM memories WHERE id = 'mem-2'`).get();
    expect(row).toBeUndefined();
  });

  it('is idempotent — applying same op twice is safe', async () => {
    const identity = getOrCreateDeviceIdentity(db);
    const other = generateKeypair();

    // Insert a memory to update
    db.prepare(
      `INSERT INTO memories (id, type, source_id, content, content_hash, properties_json,
         wikilinks_json, related_ids_json, embedding_model, created_at)
       VALUES ('mem-idem', 'notes', 'manual', 'text', 'hashidem', '{"title":"orig","tags":[]}',
         '[]', '[]', 'nomic', ?)`,
    ).run(Date.now());

    const op = buildFakeOp(other.pubkeyHex, other.privkeyHex, 'update_properties', 'mem-idem', {
      memory_id: 'mem-idem',
      delta: { title: 'updated', tags: ['sync'] },
    });

    const storeStub = {
      async insertWithoutLog() {},
      async deleteVectorIfExists() {},
    } as unknown as MemoryStore;

    const applier = new ReplayApplier(db, storeStub, masterKey);
    await applier.applyOp(op, identity.device_id);
    await applier.applyOp(op, identity.device_id); // second apply should no-op

    const row = db.prepare(`SELECT properties_json FROM memories WHERE id = 'mem-idem'`).get() as {
      properties_json: string;
    };
    const props = JSON.parse(row.properties_json) as { title: string };
    expect(props.title).toBe('updated');
  });
});

// Helper — build a signed WireOp for tests
function buildFakeOp(
  deviceId: string,
  privkeyHex: string,
  opType: string,
  memoryId: string,
  payload: Record<string, unknown>,
): WireOp {
  const opId = ulid();
  const lamportTs = 1;
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const { enc, nonce } = encryptPayload(plaintext, masterKey);
  const payloadEncB64 = enc.toString('base64');
  const nonceB64 = nonce.toString('base64');
  const canonical = opCanonicalBytes({
    op_id: opId,
    device_id: deviceId,
    lamport_ts: lamportTs,
    op_type: opType,
    memory_id: memoryId,
    payload_enc: payloadEncB64,
    nonce: nonceB64,
  });
  const sigHex = signBytes(canonical, privkeyHex);
  return {
    op_id: opId,
    device_id: deviceId,
    lamport_ts: lamportTs,
    op_type: opType as WireOp['op_type'],
    memory_id: memoryId,
    payload_enc: payloadEncB64,
    nonce: nonceB64,
    sig: sigHex,
    created_at: Date.now(),
  };
}

// Export helper for use in other test files
export { buildFakeOp };
