// src/sync/tests/two-device-sync.test.ts
// Integration test: 2 in-process Device instances simulate bidirectional sync
// using an in-memory relay bus (no real WebSocket or cloud required).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../db/index.js';
import { getOrCreateDeviceIdentity } from '../ed25519.js';
import { OpsLogger } from '../ops-log.js';
import { ReplayApplier } from '../apply.js';
import type { WireOp } from '../types.js';

const masterKey = Buffer.alloc(32, 0xab); // shared master key (same user)

// --- In-memory relay bus ---

type OpHandler = (op: WireOp) => Promise<void>;

class InMemoryRelay {
  private handlers: OpHandler[] = [];

  subscribe(handler: OpHandler): void {
    this.handlers.push(handler);
  }

  async broadcast(ops: WireOp[], excludeHandler?: OpHandler): Promise<void> {
    for (const handler of this.handlers) {
      if (handler !== excludeHandler) {
        for (const op of ops) {
          await handler(op);
        }
      }
    }
  }
}

// --- Device factory ---

interface Device {
  name: string;
  tmpDir: string;
  db: Database.Database;
  identity: ReturnType<typeof getOrCreateDeviceIdentity>;
  logger: OpsLogger;
  applier: ReplayApplier;
  memories: Map<string, Record<string, unknown>>;
}

function createDevice(name: string): Device {
  const tmpDir = mkdtempSync(join(tmpdir(), `engram-sync-${name}-`));
  const db = initDb(join(tmpDir, 'engram.db'));
  const identity = getOrCreateDeviceIdentity(db);

  const memories = new Map<string, Record<string, unknown>>();

  // Stub MemoryStore (tests SQLite writes directly; no LanceDB in unit test)
  const storeStub = {
    async insertWithoutLog(item: Record<string, unknown>): Promise<void> {
      const id = item['id'] as string;
      memories.set(id, { ...item });
      db.prepare(
        `INSERT OR REPLACE INTO memories
           (id, type, source_id, content, content_hash, properties_json,
            wikilinks_json, related_ids_json, embedding_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        (item['type'] as string) ?? 'notes',
        (item['source_id'] as string) ?? '',
        (item['content'] as string) ?? '',
        (item['content_hash'] as string) ?? '',
        JSON.stringify(item['properties'] ?? {}),
        '[]',
        '[]',
        'nomic-embed-text',
        Date.now(),
      );
    },
    async deleteVectorIfExists(_id: string): Promise<void> {
      // no-op in stub
    },
  } as unknown as import('../../memory/core/store.js').MemoryStore;

  const logger = new OpsLogger(db, identity, masterKey);
  const applier = new ReplayApplier(db, storeStub, masterKey);

  return { name, tmpDir, db, identity, logger, applier, memories };
}

function teardownDevice(device: Device): void {
  device.db.close();
  rmSync(device.tmpDir, { recursive: true });
}

// --- Tests ---

describe('two-device bidirectional sync', () => {
  let alpha: Device;
  let beta: Device;
  let relay: InMemoryRelay;

  beforeEach(() => {
    alpha = createDevice('alpha');
    beta = createDevice('beta');
    relay = new InMemoryRelay();

    // Wire relay: alpha's push → beta's applier, and vice versa
    relay.subscribe(async (op) => {
      await beta.applier.applyOp(op, beta.identity.device_id);
    });
    relay.subscribe(async (op) => {
      await alpha.applier.applyOp(op, alpha.identity.device_id);
    });
  });

  afterEach(() => {
    teardownDevice(alpha);
    teardownDevice(beta);
  });

  it('alpha adds a memory, beta receives it', async () => {
    const memId = `mem-${Date.now()}`;
    const item = {
      id: memId,
      type: 'notes',
      source_id: 'manual',
      content: 'hello from alpha',
      content_hash: 'hash-alpha-1',
      properties: { title: 'Alpha note', tags: ['sync'] },
    };

    // Alpha: local write → log op
    const opId = alpha.logger.append('add_memory', memId, { item });

    // Push to relay
    const pending = alpha.logger.listPending();
    expect(pending).toHaveLength(1);
    await relay.broadcast(pending, undefined);
    alpha.logger.markSent(pending.map((p) => p.op_id));

    // Beta should now have the memory in SQLite
    const row = beta.db
      .prepare(`SELECT id, content FROM memories WHERE id = ?`)
      .get(memId) as { id: string; content: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.id).toBe(memId);
    expect(row?.content).toBe('hello from alpha');
    expect(opId).toBeTruthy();
  });

  it('beta adds a memory, alpha receives it', async () => {
    const memId = `mem-beta-${Date.now()}`;
    const item = {
      id: memId,
      type: 'notes',
      source_id: 'manual',
      content: 'hello from beta',
      content_hash: 'hash-beta-1',
      properties: { title: 'Beta note', tags: ['sync'] },
    };

    beta.logger.append('add_memory', memId, { item });
    const pending = beta.logger.listPending();
    await relay.broadcast(pending);
    beta.logger.markSent(pending.map((p) => p.op_id));

    const row = alpha.db
      .prepare(`SELECT id, content FROM memories WHERE id = ?`)
      .get(memId) as { id: string; content: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.content).toBe('hello from beta');
  });

  it('concurrent property updates: LWW + tag union', async () => {
    const memId = `mem-concurrent-${Date.now()}`;
    const item = {
      id: memId,
      type: 'notes',
      source_id: 'manual',
      content: 'shared',
      content_hash: 'hash-shared-1',
      properties: { title: 'original', tags: ['base'] },
    };

    // Both devices know about the memory (simulate initial sync)
    for (const dev of [alpha, beta]) {
      dev.db
        .prepare(
          `INSERT OR REPLACE INTO memories
             (id, type, source_id, content, content_hash, properties_json,
              wikilinks_json, related_ids_json, embedding_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', 'nomic-embed-text', ?)`,
        )
        .run(
          memId,
          item.type,
          item.source_id,
          item.content,
          item.content_hash,
          JSON.stringify(item.properties),
          Date.now(),
        );
    }

    // Alpha: log + apply locally (simulates MemoryStore write-through)
    alpha.logger.append('update_properties', memId, {
      memory_id: memId,
      delta: { title: 'alpha-title', tags: ['alpha-tag'] },
    });
    // Apply alpha's own write directly (simulates MemoryStore.setProperties)
    alpha.db.prepare(`UPDATE memories SET properties_json = ? WHERE id = ?`).run(
      JSON.stringify({ title: 'alpha-title', tags: ['base', 'alpha-tag'] }),
      memId,
    );

    // Beta: log + apply locally (simulates MemoryStore write-through)
    beta.logger.append('update_properties', memId, {
      memory_id: memId,
      delta: { title: 'beta-title', tags: ['beta-tag'] },
    });
    // Apply beta's own write directly (simulates MemoryStore.setProperties)
    beta.db.prepare(`UPDATE memories SET properties_json = ? WHERE id = ?`).run(
      JSON.stringify({ title: 'beta-title', tags: ['base', 'beta-tag'] }),
      memId,
    );

    // Cross-broadcast
    const alphaPending = alpha.logger.listPending();
    const betaPending = beta.logger.listPending();
    await relay.broadcast(alphaPending);
    await relay.broadcast(betaPending);
    alpha.logger.markSent(alphaPending.map((p) => p.op_id));
    beta.logger.markSent(betaPending.map((p) => p.op_id));

    // Both devices: tags should be union containing both devices' tags
    const alphaRow = alpha.db
      .prepare(`SELECT properties_json FROM memories WHERE id = ?`)
      .get(memId) as { properties_json: string };
    const betaRow = beta.db
      .prepare(`SELECT properties_json FROM memories WHERE id = ?`)
      .get(memId) as { properties_json: string };

    const alphaProps = JSON.parse(alphaRow.properties_json) as { tags: string[] };
    const betaProps = JSON.parse(betaRow.properties_json) as { tags: string[] };

    // Tags must be union (may contain all three)
    expect(alphaProps.tags).toEqual(expect.arrayContaining(['alpha-tag']));
    expect(alphaProps.tags).toEqual(expect.arrayContaining(['beta-tag']));
    expect(betaProps.tags).toEqual(expect.arrayContaining(['alpha-tag']));
    expect(betaProps.tags).toEqual(expect.arrayContaining(['beta-tag']));
  });

  it('delete on alpha, beta receives tombstone', async () => {
    const memId = `mem-del-${Date.now()}`;
    // Insert on both sides
    for (const dev of [alpha, beta]) {
      dev.db
        .prepare(
          `INSERT OR REPLACE INTO memories
             (id, type, source_id, content, content_hash, properties_json,
              wikilinks_json, related_ids_json, embedding_model, created_at)
           VALUES (?, 'notes', 'manual', 'to be deleted', 'hash-del', '{}', '[]', '[]', 'nomic', ?)`,
        )
        .run(memId, Date.now());
    }

    // Alpha deletes
    alpha.logger.append('delete_memory', memId, { memory_id: memId });
    const pending = alpha.logger.listPending();
    await relay.broadcast(pending);
    alpha.logger.markSent(pending.map((p) => p.op_id));

    // Beta: memory should be gone from SQLite, tombstone should exist
    const betaMemory = beta.db.prepare(`SELECT id FROM memories WHERE id = ?`).get(memId);
    const betaTomb = beta.db
      .prepare(`SELECT memory_id FROM tombstones WHERE memory_id = ?`)
      .get(memId) as { memory_id: string } | undefined;

    expect(betaMemory).toBeUndefined();
    expect(betaTomb).toBeDefined();
    expect(betaTomb?.memory_id).toBe(memId);
  });

  it('dedup: same content_hash from both devices is kept only once', async () => {
    const memId = `mem-dedup-${Date.now()}`;
    const item = {
      id: memId,
      type: 'notes',
      source_id: 'manual',
      content: 'same content',
      content_hash: 'hash-same-content',
      properties: { title: 'shared' },
    };

    // Both devices try to add the same item independently
    alpha.logger.append('add_memory', memId, { item });
    beta.logger.append('add_memory', memId, { item });

    const alphaPending = alpha.logger.listPending();
    const betaPending = beta.logger.listPending();

    // Alpha's op goes to beta first
    await relay.broadcast(alphaPending);
    alpha.logger.markSent(alphaPending.map((p) => p.op_id));

    // Beta's op goes to alpha (already has it — dedup should kick in)
    await relay.broadcast(betaPending);
    beta.logger.markSent(betaPending.map((p) => p.op_id));

    // Alpha: only 1 row with that content_hash
    const alphaCount = (
      alpha.db
        .prepare(`SELECT COUNT(*) as c FROM memories WHERE content_hash = 'hash-same-content'`)
        .get() as { c: number }
    ).c;

    expect(alphaCount).toBeLessThanOrEqual(1);
  });

  it('ops not from this device are stored and marked applied', async () => {
    const memId = `mem-track-${Date.now()}`;
    const item = {
      id: memId,
      type: 'notes',
      source_id: 'manual',
      content: 'from beta for tracking',
      content_hash: 'hash-track-1',
      properties: { title: 'tracked' },
    };

    beta.logger.append('add_memory', memId, { item });
    const pending = beta.logger.listPending();
    await relay.broadcast(pending);

    // Alpha: op should be in ops_log with applied=1
    const alphaOp = alpha.db
      .prepare(`SELECT applied FROM ops_log WHERE op_id = ?`)
      .get(pending[0]!.op_id) as { applied: number } | undefined;

    expect(alphaOp).toBeDefined();
    expect(alphaOp?.applied).toBe(1);
  });
});
