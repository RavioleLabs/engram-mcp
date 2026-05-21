// src/sync/replay.ts
import { createLogger } from '../logger.js';
import { WireOpSchema } from './types.js';
import type { ReplayApplier } from './apply.js';
import type { OpsLogger } from './ops-log.js';

const log = createLogger('sync:replay');

export interface ReplayOptions {
  cloudBaseUrl: string;
  jwtToken: string;
  localDeviceId: string;
  opsLogger: OpsLogger;
  applier: ReplayApplier;
  batchSize?: number;
}

/**
 * Fetch and apply all ops from cloud that are newer than the local max applied op.
 * Iterates until the server returns fewer ops than `batchSize` (no more to fetch).
 * Safe to call on every boot — idempotent via op_id deduplication in ReplayApplier.
 */
export async function replayFromCloud(opts: ReplayOptions): Promise<{ applied: number }> {
  const batchSize = opts.batchSize ?? 200;
  let afterOpId = ''; // start from the beginning on first run
  let totalApplied = 0;

  // Find the last op_id we have applied (ULID = lexicographic ordering)
  const maxAppliedOpId = opts.opsLogger.maxAppliedOpId();
  if (maxAppliedOpId) afterOpId = maxAppliedOpId;

  log.info('starting catch-up replay', { afterOpId: afterOpId || '(start)', batchSize });

  while (true) {
    const url = new URL(`${opts.cloudBaseUrl}/sync/ops`);
    url.searchParams.set('after', afterOpId);
    url.searchParams.set('limit', String(batchSize));

    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${opts.jwtToken}` },
      });
    } catch (err) {
      log.warn('catch-up fetch failed — will retry on reconnect', { err });
      break;
    }

    if (!resp.ok) {
      log.warn('catch-up fetch non-200', { status: resp.status });
      break;
    }

    const body = (await resp.json()) as { ops: unknown[]; count: number };
    const ops = body.ops ?? [];

    log.debug('catch-up batch received', { count: ops.length });

    for (const raw of ops) {
      try {
        const op = WireOpSchema.parse(raw);
        await opts.applier.applyOp(op, opts.localDeviceId);
        afterOpId = op.op_id; // advance cursor
        totalApplied++;
      } catch (err) {
        log.warn('failed to parse/apply catch-up op', { err });
      }
    }

    if (ops.length < batchSize) {
      // Server has no more ops — done
      break;
    }
  }

  log.info('catch-up replay complete', { totalApplied });
  return { applied: totalApplied };
}
