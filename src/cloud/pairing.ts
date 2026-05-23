/**
 * src/cloud/pairing.ts
 *
 * Pairing flow: open browser → engram-mcp.com/pair/<token> → user logs in →
 * app redirects to localhost callback → JWT + API key received → saved.
 *
 * The localhost callback server uses the built-in Node.js `http` module
 * (no extra deps). It binds to 127.0.0.1 only.
 */

import { ENGRAM_APP_BASE } from './endpoints.js';
import http from 'http';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { URL } from 'url';
import { createLogger } from '../logger.js';
import { saveTokens, parseJwtExpiry } from './auth.js';

const log = createLogger('cloud:pairing');

const CALLBACK_PORT = 7778;
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface PairingResult {
  jwt: string;
  refreshToken: string;
  apiKey: string;
  expiresAt: number;
}

/**
 * Generate a URL-safe base64 pairing token (32 random bytes = 43 chars).
 */
function generatePairingToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Open a URL in the default system browser (cross-platform).
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync(`open "${url}"`);
    } else if (platform === 'win32') {
      execSync(`start "" "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
    log.info(`Browser opened to ${url}`);
  } catch (e) {
    // Don't throw — user can copy-paste the URL
    log.warn(`Could not auto-open browser: ${e instanceof Error ? e.message : String(e)}`);
    // eslint-disable-next-line no-console
    console.log(`\nOpen this URL manually:\n  ${url}\n`);
  }
}

/**
 * Start the localhost callback HTTP server.
 * Returns a promise that resolves when the callback arrives (with tokens)
 * or rejects on timeout / error.
 */
function startCallbackServer(): Promise<PairingResult> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // SECURITY: prefer reading tokens from the request body (POST) rather
      // than the URL query string. URLs end up in DevTools Network panel,
      // server access logs, and Referer headers — bodies do not. Fall back
      // to query string so dashboards predating this change still work.
      let jwt = '';
      let refreshToken = '';
      let apiKey = '';
      const parsed = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        let total = 0;
        const MAX = 64 * 1024; // 64 KB cap — tokens are tiny; reject larger
        try {
          for await (const chunk of req) {
            const buf = chunk as Buffer;
            total += buf.length;
            if (total > MAX) {
              res.writeHead(413);
              res.end('Body too large');
              return;
            }
            chunks.push(buf);
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw) {
            const body = JSON.parse(raw) as Record<string, unknown>;
            if (typeof body.jwt === 'string') jwt = body.jwt;
            if (typeof body.refreshToken === 'string') refreshToken = body.refreshToken;
            if (typeof body.apiKey === 'string') apiKey = body.apiKey;
          }
        } catch {
          // Body unreadable or not JSON — fall through to query string
        }
      }

      // Query-string fallback for backwards compatibility with older dashboards
      if (!jwt) jwt = parsed.searchParams.get('jwt') ?? '';
      if (!refreshToken) refreshToken = parsed.searchParams.get('refreshToken') ?? '';
      if (!apiKey) apiKey = parsed.searchParams.get('apiKey') ?? '';

      if (!jwt || !refreshToken || !apiKey) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<p>Pairing failed — missing parameters. Close this tab and try again.</p>');
        reject(new Error('Callback missing jwt, refreshToken, or apiKey'));
        server.close();
        return;
      }

      let expiresAt: number;
      try {
        expiresAt = parseJwtExpiry(jwt);
      } catch {
        expiresAt = Date.now() + 3600_000; // fallback: 1h
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!DOCTYPE html>
<html>
<head>
  <title>EngramMCP Paired</title>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #09090b; color: #f4f4f5; display: flex; align-items: center;
           justify-content: center; height: 100vh; margin: 0; }
    .card { text-align: center; padding: 48px 40px; border-radius: 16px;
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
            backdrop-filter: blur(12px); max-width: 360px; }
    .check { font-size: 3rem; margin-bottom: 16px; }
    h2 { margin: 0 0 8px; font-size: 1.4rem; font-weight: 600; }
    p { margin: 0; color: #a1a1aa; font-size: 0.9rem; }
    .countdown { font-size: 0.75rem; color: #52525b; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h2>Paired successfully!</h2>
    <p>Your PC is now connected to your Engram account.</p>
    <p class="countdown">This tab will close automatically…</p>
  </div>
  <script>setTimeout(() => { try { window.close(); } catch(e) {} }, 2000);</script>
</body>
</html>`,
      );

      server.close();
      resolve({ jwt, refreshToken, apiKey, expiresAt });
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      log.info(`Pairing callback server listening on http://127.0.0.1:${CALLBACK_PORT}`);
    });

    server.on('error', (err) => {
      reject(new Error(`Pairing callback server error: ${err.message}`));
    });

    // Timeout guard
    setTimeout(() => {
      server.close();
      reject(new Error(`Pairing timed out after ${PAIRING_TIMEOUT_MS / 60_000} minutes`));
    }, PAIRING_TIMEOUT_MS);
  });
}

export interface StartPairingOptions {
  /** Plan J / I base URL (default prod) */
  baseUrl?: string;
}

/**
 * Full pairing flow:
 * 1. Generate token
 * 2. Start callback server
 * 3. Open browser
 * 4. Wait for callback
 * 5. Save tokens
 * Returns the received tokens.
 */
export async function startPairing(opts: StartPairingOptions = {}): Promise<PairingResult> {
  const baseUrl = opts.baseUrl ?? ENGRAM_APP_BASE;
  const pairingToken = generatePairingToken();
  const callbackUrl = encodeURIComponent(`http://localhost:${CALLBACK_PORT}/callback`);
  const pairingUrl = `${baseUrl}/pair/${pairingToken}?callback=${callbackUrl}`;

  /* eslint-disable no-console */
  console.log('\n  Linking your account to engram-mcp.com…\n');
  /* eslint-enable no-console */

  const callbackPromise = startCallbackServer();

  /* eslint-disable no-console */
  console.log(`  Opening browser to: ${pairingUrl}\n`);
  /* eslint-enable no-console */

  openBrowser(pairingUrl);

  /* eslint-disable no-console */
  console.log('  Waiting for authorization in your browser…');
  console.log('  (You have 5 minutes. Press Ctrl+C to cancel.)\n');
  /* eslint-enable no-console */

  const result = await callbackPromise;
  saveTokens(result);

  log.info('Pairing complete — tokens saved to oauth_tokens');
  return result;
}
