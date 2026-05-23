/**
 * Conflict Resolution Rules (Phase 3 Ops Log):
 *
 * 1. ADD_MEMORY collision (same memory_id from two devices simultaneously):
 *    → content_hash dedup: if content is identical, skip the incoming op (natural dedup).
 *    → if content differs (truly concurrent inserts), BOTH are kept (different memory_id
 *      since ID = ULID generated independently). No conflict.
 *
 * 2. UPDATE_PROPERTIES concurrent edits:
 *    → Last-writer-wins per SCALAR field (by Lamport timestamp).
 *    → ARRAY fields (tags, related_ids, wikilinks): UNION semantics — both sets merged.
 *    → Result: no data loss, arrays only grow.
 *
 * 3. DELETE vs concurrent UPDATE:
 *    → Within 5-minute grace period: higher Lamport timestamp wins.
 *      (Update with higher ts → memory survives; delete with higher ts → memory gone.)
 *    → After grace period: delete wins unconditionally.
 *
 * 4. Re-ADD of a tombstoned memory_id:
 *    → If grace period not yet elapsed: treat as resurrection (insertWithoutLog).
 *    → After grace period: blocked (tombstone finalized).
 *
 * 5. ADD_RELATION:
 *    → Pure union: idempotent insert into related_ids.
 */

// src/sync/apply.ts
import { createLogger } from '../logger.js';
import { decryptPayload } from './ops-log.js';
import { verifySignature, opCanonicalBytes } from './ed25519.js';
import type { WireOp } from './types.js';
import {
  AddMemoryPayloadSchema,
  UpdatePropertiesPayloadSchema,
  DeleteMemoryPayloadSchema,
} from './types.js';
import type { MemoryItem } from '../types.js';
import type { MemoryStore } from '../memory/core/store.js';
import Database from 'better-sqlite3';

const log = createLogger('sync:apply');

/** Last-writer-wins merge for flat properties. Arrays are union-merged. */
export function lwwMergeProperties(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  currentLamport: number,
  incomingLamport: number,
): Record<string, unknown> {
  if (incomingLamport < currentLamport) {
    // Incoming is older — only merge arrays (union), scalar fields from current win
    const result = { ...current };
    for (const [key, val] of Object.entries(incoming)) {
      if (Array.isArray(val) && Array.isArray(current[key])) {
        result[key] = [...new Set([...(current[key] as unknown[]), ...val])];
      }
      // Scalar: current wins (incomingLamport is older)
    }
    return result;
  }

  // Incoming is newer — incoming scalar wins; arrays union
  const result = { ...incoming };
  for (const [key, val] of Object.entries(current)) {
    if (Array.isArray(val) && Array.isArray(incoming[key])) {
      result[key] = [...new Set([...val, ...(incoming[key] as unknown[])])];
    }
    // Scalars already set from incoming spread above
  }
  return result;
}

/** Resolve delete vs concurrent update. */
export function resolveDeleteVsUpdate(
  tombstone: { deleted_at: number; grace_until: number } | undefined,
  incomingLamport: number,
  deleteLamport: number,
): 'apply_delete' | 'apply_update' | 'defer' {
  if (!tombstone) return 'apply_update'; // no tombstone — normal update
  if (Date.now() < tombstone.grace_until) {
    // Within grace period — higher lamport wins
    return incomingLamport > deleteLamport ? 'apply_update' : 'defer';
  }
  // Grace period expired — delete wins
  return 'apply_delete';
}

export class ReplayApplier {
  private db: Database.Database;
  private store: MemoryStore;
  private masterKey: Buffer;

  constructor(db: Database.Database, store: MemoryStore, masterKey: Buffer) {
    this.db = db;
    this.store = store;
    this.masterKey = masterKey;
  }

  /**
   * Apply a single WireOp received from cloud or catch-up.
   * Skips ops that originated from this device (already applied locally).
   * Idempotent: re-applying the same op_id is a no-op.
   */
  async applyOp(op: WireOp, localDeviceId: string): Promise<void> {
    // 0. Skip own ops
    if (op.device_id === localDeviceId) {
      log.debug('skip own op', { op_id: op.op_id });
      return;
    }

    // 1. Idempotency check
    const existing = this.db
      .prepare(`SELECT applied FROM ops_log WHERE op_id = ?`)
      .get(op.op_id) as { applied: number } | undefined;
    if (existing?.applied === 1) {
      log.debug('op already applied', { op_id: op.op_id });
      return;
    }

    // 2. Verify signature
    const canonical = opCanonicalBytes({
      op_id: op.op_id,
      device_id: op.device_id,
      lamport_ts: op.lamport_ts,
      op_type: op.op_type,
      memory_id: op.memory_id,
      payload_enc: op.payload_enc,
      nonce: op.nonce,
    });
    if (!verifySignature(canonical, op.sig, op.device_id)) {
      log.warn('invalid signature — op rejected', {
        op_id: op.op_id,
        device: op.device_id.slice(0, 8),
      });
      return;
    }

    // 3. Decrypt payload
    let payload: Record<string, unknown>;
    try {
      const enc = Buffer.from(op.payload_enc, 'base64');
      const nonce = Buffer.from(op.nonce, 'base64');
      const plain = decryptPayload(enc, nonce, this.masterKey);
      payload = JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
    } catch (err) {
      log.warn('failed to decrypt op payload', { op_id: op.op_id, err });
      return;
    }

    // 4. Store op in local ops_log (so we track it)
    const alreadyStored = this.db
      .prepare(`SELECT op_id FROM ops_log WHERE op_id = ?`)
      .get(op.op_id);
    if (!alreadyStored) {
      this.db
        .prepare(
          `INSERT INTO ops_log
             (op_id, device_id, lamport_ts, op_type, memory_id,
              payload_enc, nonce, sig, sent_at, applied, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          op.op_id,
          op.device_id,
          op.lamport_ts,
          op.op_type,
          op.memory_id,
          Buffer.from(op.payload_enc, 'base64'),
          Buffer.from(op.nonce, 'base64'),
          Buffer.from(op.sig, 'hex'),
          Date.now(), // sent_at — already sent (received from cloud)
          op.created_at,
        );
    }

    // 5. Dispatch by op_type
    try {
      switch (op.op_type) {
        case 'add_memory':
          await this.#applyAddMemory(op, payload);
          break;
        case 'update_properties':
          await this.#applyUpdateProperties(op, payload);
          break;
        case 'delete_memory':
          await this.#applyDeleteMemory(op, payload);
          break;
        case 'add_relation':
          await this.#applyAddRelation(op, payload);
          break;
        default:
          log.warn('unknown op_type', { op_id: op.op_id, op_type: op.op_type });
      }
    } catch (err) {
      log.error('failed to apply op', { op_id: op.op_id, err });
      return;
    }

    // 6. Mark applied
    this.db.prepare(`UPDATE ops_log SET applied = 1 WHERE op_id = ?`).run(op.op_id);
    log.debug('op applied', {
      op_id: op.op_id,
      op_type: op.op_type,
      memory_id: op.memory_id,
    });
  }

  async #applyAddMemory(op: WireOp, payload: Record<string, unknown>): Promise<void> {
    const { item } = AddMemoryPayloadSchema.parse(payload);
    const memoryItem = item as unknown as MemoryItem;

    // Dedup by content_hash
    const dup = this.db
      .prepare(`SELECT id FROM memories WHERE content_hash = ?`)
      .get(memoryItem.content_hash);
    if (dup) {
      log.debug('add_memory dedup by content_hash', {
        op_id: op.op_id,
        hash: memoryItem.content_hash,
      });
      return;
    }

    // Check tombstone — if deleted and grace expired, skip
    const tomb = this.db
      .prepare(`SELECT deleted_at, grace_until FROM tombstones WHERE memory_id = ?`)
      .get(memoryItem.id) as { deleted_at: number; grace_until: number } | undefined;
    if (tomb && Date.now() >= tomb.grace_until) {
      log.debug('add_memory blocked by finalized tombstone', { memory_id: memoryItem.id });
      return;
    }

    // Disable ops logging for the derived write (avoid double-logging)
    await this.store.insertWithoutLog(memoryItem);
  }

  async #applyUpdateProperties(op: WireOp, payload: Record<string, unknown>): Promise<void> {
    const { memory_id, delta } = UpdatePropertiesPayloadSchema.parse(payload);

    // Check tombstone
    const tomb = this.db
      .prepare(`SELECT deleted_at, grace_until FROM tombstones WHERE memory_id = ?`)
      .get(memory_id) as { deleted_at: number; grace_until: number } | undefined;

    // Find existing item for LWW merge
    const existingRow = this.db
      .prepare(`SELECT properties_json FROM memories WHERE id = ?`)
      .get(memory_id) as { properties_json: string } | undefined;

    if (!existingRow) {
      log.debug('update_properties: memory not found locally yet', { memory_id });
      return; // Will be applied once add_memory arrives
    }

    // LWW merge
    const current = JSON.parse(existingRow.properties_json) as Record<string, unknown>;
    const lastUpdateLamport =
      (
        this.db
          .prepare(
            `SELECT MAX(lamport_ts) as m FROM ops_log
           WHERE memory_id = ? AND op_type = 'update_properties' AND applied = 1`,
          )
          .get(memory_id) as { m: number | null }
      ).m ?? 0;

    const verdict = tomb
      ? resolveDeleteVsUpdate(tomb, op.lamport_ts, tomb.deleted_at)
      : 'apply_update';

    if (verdict !== 'apply_update') {
      log.debug('update_properties blocked by tombstone resolution', { memory_id, verdict });
      return;
    }

    const merged = lwwMergeProperties(
      current,
      delta as Record<string, unknown>,
      lastUpdateLamport,
      op.lamport_ts,
    );

    this.db
      .prepare(`UPDATE memories SET properties_json = ? WHERE id = ?`)
      .run(JSON.stringify(merged), memory_id);
  }

  async #applyDeleteMemory(op: WireOp, payload: Record<string, unknown>): Promise<void> {
    const { memory_id } = DeleteMemoryPayloadSchema.parse(payload);
    const now = Date.now();
    const GRACE_MS = 5 * 60 * 1000;

    // Upsert tombstone
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tombstones (memory_id, deleted_at, op_id, grace_until, finalized)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(memory_id, now, op.op_id, now + GRACE_MS);

    // Immediate SQLite delete
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory_id);
    this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(memory_id);

    // LanceDB: delete now if available (grace-period LanceDB deferred cleanup handled by finalizeTombstones)
    await this.store.deleteVectorIfExists(memory_id);
    log.debug('delete_memory tombstone inserted', { memory_id, grace_until: now + GRACE_MS });
  }

  async #applyAddRelation(_op: WireOp, payload: Record<string, unknown>): Promise<void> {
    const { from_id, to_id } = payload as { from_id: string; to_id: string };
    // Add to_id to from_id's related_ids if not present
    const row = this.db
      .prepare(`SELECT related_ids_json FROM memories WHERE id = ?`)
      .get(from_id) as { related_ids_json: string } | undefined;
    if (!row) return;
    const ids: string[] = JSON.parse(row.related_ids_json ?? '[]');
    if (!ids.includes(to_id)) {
      ids.push(to_id);
      this.db
        .prepare(`UPDATE memories SET related_ids_json = ? WHERE id = ?`)
        .run(JSON.stringify(ids), from_id);
    }
  }
}

/**
 * Finalize tombstones whose grace period has elapsed.
 * Deletes from LanceDB and marks the tombstone as finalized.
 * Called from a local cron (every 10 minutes).
 */
export async function finalizeTombstones(db: Database.Database, store: MemoryStore): Promise<void> {
  const now = Date.now();
  const expired = db
    .prepare(
      `SELECT memory_id FROM tombstones
       WHERE finalized = 0 AND grace_until < ?`,
    )
    .all(now) as { memory_id: string }[];

  for (const { memory_id } of expired) {
    await store.deleteVectorIfExists(memory_id);
    db.prepare(`UPDATE tombstones SET finalized = 1 WHERE memory_id = ?`).run(memory_id);
    log.debug('tombstone finalized', { memory_id });
  }

  if (expired.length > 0) {
    log.info('finalized tombstones', { count: expired.length });
  }
}
