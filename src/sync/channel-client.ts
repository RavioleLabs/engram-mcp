// src/sync/channel-client.ts
import WebSocket from 'ws';
import { createLogger } from '../logger.js';
import type { OpsLogger } from './ops-log.js';
import type { ReplayApplier } from './apply.js';
import type { WireOp } from './types.js';
import { WireOpSchema } from './types.js';

const log = createLogger('sync:channel-client');

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

export interface ChannelClientConfig {
  cloudBaseUrl: string; // e.g. 'https://api.engram-mcp.com'
  jwtToken: string; // PC's JWT (Pro subscription required)
  deviceId: string; // ed25519 pubkey hex
  opsLogger: OpsLogger;
  applier: ReplayApplier;
  localDeviceId: string;
}

export class ChannelClient {
  private cfg: ChannelClientConfig;
  private ws: WebSocket | null = null;
  private reconnectMs: number = RECONNECT_BASE_MS;
  private stopped: boolean = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: ChannelClientConfig) {
    this.cfg = cfg;
  }

  /** Start the channel — connect + schedule periodic push of pending ops. */
  start(): void {
    this.stopped = false;
    this.#connect();
    // Push pending ops every 10 seconds even if WS is offline (will retry on reconnect)
    this.pushTimer = setInterval(() => {
      this.#pushPending().catch(() => {});
    }, 10_000);
  }

  /** Gracefully stop the channel. */
  stop(): void {
    this.stopped = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'client stop');
      this.ws = null;
    }
    log.info('channel client stopped');
  }

  /** Trigger an immediate push of pending ops (call after a local write). */
  async pushNow(): Promise<void> {
    await this.#pushPending();
  }

  #connect(): void {
    if (this.stopped) return;

    const url = new URL(`${this.cfg.cloudBaseUrl}/sync/ws`);
    url.searchParams.set('device_id', this.cfg.deviceId);

    log.info('connecting to sync channel', { url: url.toString() });

    const ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${this.cfg.jwtToken}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      log.info('sync channel connected');
      this.reconnectMs = RECONNECT_BASE_MS;
      this.#pushPending().catch(() => {});
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      this.#onMessage(data.toString()).catch((err) => {
        log.warn('error handling incoming message', { err });
      });
    });

    ws.on('close', () => {
      log.info('sync channel closed, scheduling reconnect', { nextMs: this.reconnectMs });
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.ws = null;
      if (!this.stopped) {
        setTimeout(() => this.#connect(), this.reconnectMs);
        this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
      }
    });

    ws.on('error', (err) => {
      log.warn('sync channel WS error', { err: (err as Error).message });
      // 'close' event fires after error — reconnect handled there
    });
  }

  async #onMessage(raw: string): Promise<void> {
    let msg: { type: string; ops?: unknown[] };
    try {
      msg = JSON.parse(raw) as { type: string; ops?: unknown[] };
    } catch {
      log.warn('received non-JSON message', { raw });
      return;
    }

    if (msg.type === 'incoming_ops' && Array.isArray(msg.ops)) {
      log.debug('received incoming ops', { count: msg.ops.length });
      for (const rawOp of msg.ops) {
        try {
          const op: WireOp = WireOpSchema.parse(rawOp);
          await this.cfg.applier.applyOp(op, this.cfg.localDeviceId);
        } catch (err) {
          log.warn('failed to parse/apply incoming op', { err });
        }
      }
    }
    // 'pong' is informational — no action needed
  }

  async #pushPending(): Promise<void> {
    const pending = this.cfg.opsLogger.listPending();
    if (pending.length === 0) return;

    // Prefer WS when connected — lower latency and no extra round-trip.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      log.debug('pushing pending ops via WS', { count: pending.length });
      this.ws.send(JSON.stringify({ type: 'push_ops', ops: pending }));
      this.cfg.opsLogger.markSent(pending.map((op) => op.op_id));
      return;
    }

    // WS is offline — fall back to HTTP POST /sync/ops so ops are not silently lost.
    log.debug('WS offline, pushing pending ops via HTTP POST', { count: pending.length });
    try {
      const res = await fetch(`${this.cfg.cloudBaseUrl}/sync/ops`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.jwtToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ops: pending,
          device_id: this.cfg.deviceId,
          last_lamport: pending[pending.length - 1]?.lamport_ts ?? 0,
        }),
      });
      if (res.ok) {
        this.cfg.opsLogger.markSent(pending.map((op) => op.op_id));
        const result = (await res.json()) as { accepted: number; rejected: number };
        log.info('HTTP POST flush accepted', result);
      } else {
        log.warn('HTTP POST flush failed', { status: res.status });
      }
    } catch (err) {
      log.warn('HTTP POST flush error', { err: (err as Error).message });
    }
  }
}
