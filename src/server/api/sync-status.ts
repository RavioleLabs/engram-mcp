// src/webapp/api/sync-status.ts
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import type { Request, Response } from 'express';

export function syncStatusRouter(): Router {
  const router = Router();

  router.get('/api/sync/status', (_req: Request, res: Response) => {
    let db;
    try {
      db = getDb();
    } catch {
      // DB not initialized (e.g. test env) — return disabled
      res.json({ enabled: false });
      return;
    }

    // Check if ops_log table exists (migration v4 applied)
    const hasOpsLog = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ops_log'`)
      .get();

    if (!hasOpsLog) {
      res.json({ enabled: false, reason: 'ops_log table not found (migration v4 not applied)' });
      return;
    }

    const pendingCount = (
      db.prepare(`SELECT COUNT(*) as c FROM ops_log WHERE sent_at IS NULL`).get() as { c: number }
    ).c;

    const appliedCount = (
      db.prepare(`SELECT COUNT(*) as c FROM ops_log WHERE applied = 1`).get() as { c: number }
    ).c;

    const tombstones = (
      db
        .prepare(`SELECT COUNT(*) as c FROM tombstones WHERE finalized = 0`)
        .get() as { c: number }
    ).c;

    const deviceRow = db
      .prepare(`SELECT device_id, lamport_ts, created_at FROM device_identity LIMIT 1`)
      .get() as { device_id: string; lamport_ts: number; created_at: number } | undefined;

    res.json({
      enabled: !!deviceRow,
      device_id: deviceRow ? deviceRow.device_id.slice(0, 8) + '…' : null,
      lamport_ts: deviceRow?.lamport_ts ?? 0,
      pending_ops: pendingCount,
      applied_ops: appliedCount,
      open_tombstones: tombstones,
    });
  });

  return router;
}
