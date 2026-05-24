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
import sodium from 'libsodium-wrappers';
import { ulid } from 'ulid';
import { WebSocket } from 'ws';
import { createLogger } from '../logger.js';
import { getValidJwt } from './auth.js';

// ---------------------------------------------------------------------------
// Noise-ish ECDH session — matches src/lib/noise.ts in engram-app (browser side)
// ---------------------------------------------------------------------------
//
// Wire protocol (matches browser lib/bridge.ts handshake):
//   1. On WS open, PC generates an X25519 keypair and sends its public key
//      (32 raw bytes) as a binary frame. If no app peer is connected yet, the
//      relay drops the frame — that's fine: PC re-sends on `peer_connected`.
//   2. Browser receives the 32 bytes, generates its own keypair, derives
//      shared session keys via crypto_kx_client_session_keys, sends its
//      pubkey back.
//   3. PC receives the 32-byte browser pubkey, derives shared keys via
//      crypto_kx_server_session_keys (note: client/server roles must be
//      symmetric — client.sharedTx == server.sharedRx and vice versa).
//   4. All subsequent peer frames are: nonce(24) || secretbox_easy(plaintext)
//
// Why this is worth it: TLS to api.engram-mcp.com already covers transport
// confidentiality, but the relay Durable Object brokers the WSS frames in
// plaintext — anything we don't encrypt is visible to RavioleLabs operators
// and to anyone with CF log access. The Noise layer makes the relay
// effectively blind to bridge content: it sees opaque ciphertext, the keys
// never leave PC ↔ browser. Without out-of-band pubkey trust the relay
// COULD still MITM by swapping pubkeys, so this is defense-in-depth, not a
// hard guarantee against a compromised relay operator.

interface NoiseSession {
  sharedTx: Uint8Array;
  sharedRx: Uint8Array;
  nonceTx: bigint;
}

let _sodiumReady = false;
async function ensureSodium(): Promise<void> {
  if (_sodiumReady) return;
  await sodium.ready;
  _sodiumReady = true;
}

function makeServerSession(
  myKp: { publicKey: Uint8Array; privateKey: Uint8Array },
  peerPub: Uint8Array,
): NoiseSession {
  const k = sodium.crypto_kx_server_session_keys(myKp.publicKey, myKp.privateKey, peerPub);
  return { sharedTx: k.sharedTx, sharedRx: k.sharedRx, nonceTx: 0n };
}

function encryptFrame(session: NoiseSession, plaintext: Uint8Array): Uint8Array {
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  const n = new Uint8Array(nonceLen);
  const view = new DataView(n.buffer);
  view.setBigUint64(nonceLen - 8, session.nonceTx++, false);
  const ct = sodium.crypto_secretbox_easy(plaintext, n, session.sharedTx);
  const out = new Uint8Array(nonceLen + ct.length);
  out.set(n, 0);
  out.set(ct, nonceLen);
  return out;
}

function decryptFrame(session: NoiseSession, cipher: Uint8Array): Uint8Array {
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  const n = cipher.slice(0, nonceLen);
  const ct = cipher.slice(nonceLen);
  const opened = sodium.crypto_secretbox_open_easy(ct, n, session.sharedRx);
  if (!opened) throw new Error('decrypt failed');
  return opened;
}
import { makeCheckServerIdentity } from './tls-pin.js';

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
  // SECURITY: only forward a fixed whitelist of headers back through the
  // cloud relay. Forwarding everything would leak Set-Cookie, Authorization,
  // and any future auth headers the local /api/* might emit — those should
  // never leave the user's machine.
  const SAFE_HEADERS = new Set([
    'content-type',
    'content-length',
    'cache-control',
    'etag',
    'last-modified',
  ]);
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (SAFE_HEADERS.has(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
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
          // SECURITY: defeat corporate MitM proxies that install a rogue
          // root CA in the OS trust store. See makeCheckServerIdentity in
          // tls-pin.ts. ws's types declare a stricter callback signature
          // than Node's tls.connect actually accepts — cast through unknown.
          checkServerIdentity: makeCheckServerIdentity() as unknown as (
            servername: string,
            cert: string | Buffer | (string | Buffer)[],
          ) => boolean,
        });

        // Noise session state — reset on every WSS (re)connect so each
        // dashboard session gets a fresh pair of session keys (forward
        // secrecy). The keypair lives in memory only.
        let noiseKp: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;
        let noiseSession: NoiseSession | null = null;

        ws.on('open', async () => {
          log.info('Bridge relay: connected (initiating Noise handshake)');
          reconnectDelay = RECONNECT_BASE_MS; // reset backoff on success
          try {
            await ensureSodium();
            noiseKp = sodium.crypto_kx_keypair();
            // Send our pubkey as a raw 32-byte binary frame. If no app peer is
            // connected the relay drops it; we'll resend on peer_connected.
            ws!.send(Buffer.from(noiseKp.publicKey));
          } catch (e) {
            log.error(
              `Bridge relay: handshake init failed — ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        });

        ws.on('message', async (data) => {
          // Relay control frames are JSON UTF-8 strings; peer frames are
          // binary (pubkey during handshake, then encrypted tunnel frames).
          // Probe JSON first since it's the cheaper failure mode.
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const asStr = buf.toString('utf8');
          let isControl = false;
          let controlObj: Record<string, unknown> | null = null;
          if (asStr.length > 0 && asStr[0] === '{') {
            try {
              const parsed = JSON.parse(asStr) as Record<string, unknown>;
              if (
                typeof parsed.type === 'string' &&
                parsed.requestId === undefined &&
                parsed.path === undefined
              ) {
                isControl = true;
                controlObj = parsed;
              }
            } catch {
              // not JSON — treat as binary peer frame below
            }
          }

          if (isControl && controlObj) {
            const t = controlObj.type as string;
            log.debug(`Bridge relay: control frame type=${t}`);
            if (t === 'peer_connected' && noiseKp) {
              // Browser just joined — resend our pubkey so its handshake can
              // proceed. Also drop any stale session keys from a previous
              // browser tab so the next encrypted frame derives from this
              // new peer's pubkey.
              noiseSession = null;
              log.info('Bridge relay: peer connected — resending pubkey');
              try {
                ws!.send(Buffer.from(noiseKp.publicKey));
              } catch (e) {
                log.warn(`Bridge relay: failed to resend pubkey — ${String(e)}`);
              }
            } else if (t === 'peer_disconnected') {
              noiseSession = null; // wipe session keys until next handshake
            }
            return;
          }

          // Binary peer frame
          const bytes = new Uint8Array(buf);

          if (!noiseSession) {
            // Handshake phase — expect 32-byte browser pubkey
            if (bytes.length === 32 && noiseKp) {
              try {
                noiseSession = makeServerSession(noiseKp, bytes);
                log.info('Bridge relay: Noise handshake complete (channel encrypted)');
              } catch (e) {
                log.error(
                  `Bridge relay: server session derivation failed — ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              }
              return;
            }
            log.warn(
              `Bridge relay: unexpected pre-handshake frame (${bytes.length} bytes), ignoring`,
            );
            return;
          }

          // Encrypted tunnel request — decrypt with sharedRx, parse as JSON
          let plain: Uint8Array;
          try {
            plain = decryptFrame(noiseSession, bytes);
          } catch (e) {
            log.warn(
              `Bridge relay: decrypt failed — ${
                e instanceof Error ? e.message : String(e)
              } (likely out-of-order or peer rotation)`,
            );
            return;
          }
          let msg: unknown;
          try {
            msg = JSON.parse(new TextDecoder().decode(plain));
          } catch {
            log.warn('Bridge relay: decrypted frame is not JSON');
            return;
          }
          const obj = msg as Record<string, unknown>;

          // Tunnel request must have requestId + method + path with strict shape.
          // SECURITY: a malicious or compromised cloud relay could send crafted
          // frames trying to fool the bridge into hitting arbitrary local URLs.
          // Lock the method to a known HTTP verb allowlist and require path to
          // start with /api/ — forwardToLocal() also enforces this, but failing
          // fast at the frame layer keeps logs cleaner and rules out odd inputs
          // (e.g. method="CONNECT" probing for proxy behavior, path with NUL
          // bytes, host-header smuggling via path).
          const ALLOWED_METHODS = new Set([
            'GET',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
            'HEAD',
            'OPTIONS',
          ]);
          if (
            typeof obj.requestId !== 'string' ||
            obj.requestId.length === 0 ||
            obj.requestId.length > 128 ||
            typeof obj.method !== 'string' ||
            !ALLOWED_METHODS.has(obj.method.toUpperCase()) ||
            typeof obj.path !== 'string' ||
            !obj.path.startsWith('/api/') ||
            obj.path.includes('\0') ||
            obj.path.length > 2048
          ) {
            log.warn(
              `Bridge relay: rejected tunnel frame (bad shape) reqId=${
                typeof obj.requestId === 'string' ? obj.requestId.slice(0, 20) : '?'
              } method=${typeof obj.method === 'string' ? obj.method.slice(0, 20) : '?'}`,
            );
            return;
          }

          // Optional fields: validate types if present (defense against weird
          // body types upstream that would crash forwardToLocal).
          if (
            obj.headers !== undefined &&
            (typeof obj.headers !== 'object' || obj.headers === null)
          ) {
            log.warn(`Bridge relay: rejected frame, headers not object`);
            return;
          }
          if (obj.body !== undefined && typeof obj.body !== 'string') {
            log.warn(`Bridge relay: rejected frame, body not string`);
            return;
          }

          const req = obj as unknown as TunnelRequest;
          log.debug(`Bridge relay: tunnel request ${req.requestId} ${req.method} ${req.path}`);

          const response = await forwardToLocal(req, opts.localPort);
          if (ws?.readyState === WebSocket.OPEN && noiseSession) {
            try {
              const ct = encryptFrame(
                noiseSession,
                new TextEncoder().encode(JSON.stringify(response)),
              );
              ws.send(ct);
            } catch (e) {
              log.warn(
                `Bridge relay: failed to encrypt response — ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
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
