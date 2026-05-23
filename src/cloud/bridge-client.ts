/**
 * src/cloud/bridge-client.ts
 *
 * Bridge Relay WSS client.
 *
 * Maintains a persistent WebSocket connection to the Plan J Bridge Relay DO
 * so that engram-mcp.com (Plan L) can proxy REST API requests to the user's local
 * Express server without the PC needing a public IP or port-forward.
 *
 * Security constraints enforced on the PC side:
 * - Only /api/* paths are forwarded (all other paths → 403)
 * - Body size limit: 4MB (same as Express limit)
 * - Read-only paths that mutate state (/api/reindex, DELETE /api/memories/*)
 *   are still allowed because they require the user to be authenticated to
 *   engram-mcp.com — the bridge is an authenticated channel, not a public one.
 *
 * Reconnect: exponential backoff 1s → 2s → 4s → … capped at 60s.
 * The bridge client does NOT start if engramAccount is absent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { WebSocket } from 'ws';
import { createLogger } from '../logger.js';
import { getValidJwt } from './auth.js';

/**
 * Load or create a stable device_id for this machine. Persisted at
 * ~/.engram/device-id so reconnects + restarts all use the same identifier.
 * The cloud relay uses (user_id, device_id) to keep one row per physical
 * machine in relay_sessions instead of one row per WS session.
 */
function getOrCreateDeviceIdentity(): { deviceId: string; deviceName: string } {
  const engramDir = path.join(os.homedir(), '.engram');
  const deviceFile = path.join(engramDir, 'device-id');
  let deviceId: string | null = null;
  try {
    if (fs.existsSync(deviceFile)) {
      const v = fs.readFileSync(deviceFile, 'utf8').trim();
      if (v && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v)) deviceId = v;
    }
  } catch {
    // ignore — generate fresh below
  }
  if (!deviceId) {
    deviceId = ulid();
    try {
      fs.mkdirSync(engramDir, { recursive: true });
      fs.writeFileSync(deviceFile, deviceId + '\n', { mode: 0o600 });
    } catch {
      // best-effort — non-persistent device_id is still better than none
    }
  }
  const deviceName = (os.hostname() || 'PC').slice(0, 64);
  return { deviceId, deviceName };
}

const log = createLogger('cloud:bridge');

const RELAY_PATH = '/relay/pc';
const LOCAL_API_BASE = 'http://127.0.0.1';
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4MB
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Tunnel message types (matches Plan J Bridge Relay DO protocol)
// ---------------------------------------------------------------------------

interface TunnelRequest {
  requestId: string;
  method: string;
  path: string; // e.g. '/api/memories?type=notes'
  headers: Record<string, string>;
  body?: string; // JSON-encoded or base64 for binary
}

interface TunnelResponse {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string; // JSON string
}

// ---------------------------------------------------------------------------
// Local HTTP forwarder
// ---------------------------------------------------------------------------

async function forwardToLocal(req: TunnelRequest, localPort: number): Promise<TunnelResponse> {
  // Security: only /api/* paths
  if (!req.path.startsWith('/api/')) {
    return {
      requestId: req.requestId,
      status: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Bridge relay only forwards /api/* paths' }),
    };
  }

  const url = `${LOCAL_API_BASE}:${localPort}${req.path}`;
  const fetchInit: RequestInit = {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      ...req.headers,
    },
    signal: AbortSignal.timeout(30_000),
  };

  if (req.body && !['GET', 'HEAD', 'DELETE'].includes(req.method.toUpperCase())) {
    if (req.body.length > MAX_BODY_BYTES) {
      return {
        requestId: req.requestId,
        status: 413,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Request body too large (max 4MB)' }),
      };
    }
    fetchInit.body = req.body;
  }

  let res: Response;
  try {
    res = await fetch(url, fetchInit);
  } catch (e) {
    return {
      requestId: req.requestId,
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `Local API unreachable: ${e instanceof Error ? e.message : String(e)}`,
      }),
    };
  }

  const responseBody = await res.text();
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    requestId: req.requestId,
    status: res.status,
    headers: responseHeaders,
    body: responseBody,
  };
}

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

export interface BridgeClientOptions {
  baseUrl: string; // e.g. 'https://api.engram-mcp.com' — converted to wss://
  localPort: number; // local Express port (default 7777)
}

export interface BridgeClient {
  /** Stop the client and close the WebSocket. */
  stop: () => void;
}

export function startBridgeClient(opts: BridgeClientOptions): BridgeClient {
  const { deviceId, deviceName } = getOrCreateDeviceIdentity();
  const wsBase =
    opts.baseUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
      .replace(/\/$/, '') + RELAY_PATH;
  const wsUrl = `${wsBase}?device_id=${encodeURIComponent(
    deviceId,
  )}&device_name=${encodeURIComponent(deviceName)}`;

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function connect(): void {
    if (stopped) return;

    log.info(`Bridge relay: connecting to ${wsUrl}`);

    // Resolve JWT asynchronously — if it fails, we retry later
    getValidJwt(opts.baseUrl)
      .then((jwt) => {
        if (stopped) return;

        ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${jwt}` },
        });

        ws.on('open', () => {
          log.info('Bridge relay: connected');
          reconnectDelay = RECONNECT_BASE_MS; // reset backoff on success
          ws!.send(JSON.stringify({ type: 'pc_ready' }));
        });

        ws.on('message', async (data) => {
          let msg: unknown;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            log.warn('Bridge relay: received non-JSON message, ignoring');
            return;
          }

          // Ignore relay control frames (heartbeat, peer events) — they aren't tunnel requests.
          // Heartbeat: {type:"ping",ts:...}
          // Peer events: {type:"peer_disconnected"|"peer_offline","role":...}
          // Error: {type:"error","code":...}
          const obj = msg as Record<string, unknown>;
          if (typeof obj.type === 'string' && obj.path === undefined) {
            log.debug(`Bridge relay: control frame type=${obj.type as string} (ignoring)`);
            return;
          }

          // Tunnel request must have requestId + method + path
          if (
            typeof obj.requestId !== 'string' ||
            typeof obj.method !== 'string' ||
            typeof obj.path !== 'string'
          ) {
            log.warn(
              `Bridge relay: invalid tunnel frame (missing requestId/method/path), ignoring`,
            );
            return;
          }

          const req = obj as unknown as TunnelRequest;
          log.debug(`Bridge relay: tunnel request ${req.requestId} ${req.method} ${req.path}`);

          const response = await forwardToLocal(req, opts.localPort);
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
          }
        });

        ws.on('close', (code, reason) => {
          log.warn(
            `Bridge relay: disconnected (code=${code}, reason=${reason.toString().slice(0, 80)})`,
          );
          scheduleReconnect();
        });

        ws.on('error', (err) => {
          log.error(`Bridge relay: WS error: ${err.message}`);
          // 'close' event fires after 'error', so reconnect is scheduled there
        });
      })
      .catch((e) => {
        log.error(
          `Bridge relay: could not get JWT — ${e instanceof Error ? e.message : String(e)}`,
        );
        scheduleReconnect();
      });
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    log.info(`Bridge relay: reconnecting in ${reconnectDelay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      connect();
    }, reconnectDelay);
  }

  // Start first connection
  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.close(1000, 'Bridge client stopped');
        ws = null;
      }
      log.info('Bridge relay: stopped');
    },
  };
}
