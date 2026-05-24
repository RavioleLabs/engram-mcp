/**
 * src/cloud/auth.ts
 *
 * Manages the local Engram cloud account token lifecycle:
 * - Persists JWT + refresh token in the existing oauth_tokens table
 *   (provider = 'engram_account').
 * - Refreshes the JWT when it is within 2 minutes of expiry.
 * - Exposes getValidJwt() and getApiKey() for use by transit-poller and
 *   bridge-client.
 *
 * The API key is stored in `extra_json` alongside the JWT so both are in one
 * table row. The refresh token is stored in the `refresh_token` column.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import { pinnedFetch } from './tls-pin.js';

const log = createLogger('cloud:auth');

const PROVIDER = 'engram_account';
const REFRESH_BUFFER_MS = 2 * 60 * 1000; // refresh when < 2 min remaining

export interface EngramTokens {
  jwt: string;
  refreshToken: string;
  apiKey: string;
  /** Unix ms — when the JWT expires */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Persistence (oauth_tokens table)
// ---------------------------------------------------------------------------

export function saveTokens(tokens: EngramTokens): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, extra_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       extra_json = excluded.extra_json,
       updated_at = excluded.updated_at`,
  ).run(
    PROVIDER,
    tokens.jwt,
    tokens.refreshToken,
    tokens.expiresAt,
    JSON.stringify({ apiKey: tokens.apiKey }),
    Date.now(),
  );
  log.debug('Tokens saved to oauth_tokens');
}

export function loadTokens(): EngramTokens | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT access_token, refresh_token, expires_at, extra_json
       FROM oauth_tokens WHERE provider = ?`,
    )
    .get(PROVIDER) as
    | {
        access_token: string;
        refresh_token: string | null;
        expires_at: number | null;
        extra_json: string | null;
      }
    | undefined;

  if (row) {
    const extra = row.extra_json ? (JSON.parse(row.extra_json) as { apiKey?: string }) : {};
    return {
      jwt: row.access_token,
      refreshToken: row.refresh_token ?? '',
      apiKey: extra.apiKey ?? '',
      expiresAt: row.expires_at ?? 0,
    };
  }

  // Fallback: install.sh (and the legacy CLI pair script) write tokens to
  // ~/.engram/config.json under `engramAccount`. The bridge client + transit
  // poller load from oauth_tokens. If DB is empty but config has the tokens
  // (fresh install), migrate them to the DB so cloud features start working.
  try {
    const configDir = process.env.ENGRAM_CONFIG_DIR
      ? process.env.ENGRAM_CONFIG_DIR.startsWith('~')
        ? path.join(os.homedir(), process.env.ENGRAM_CONFIG_DIR.slice(1))
        : process.env.ENGRAM_CONFIG_DIR
      : path.join(os.homedir(), '.engram');
    const configPath = path.join(configDir, 'config.json');
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      engramAccount?: { jwt?: string; refreshToken?: string; apiKey?: string };
    };
    const acc = raw.engramAccount;
    if (!acc?.jwt || !acc.apiKey) return null;
    let expiresAt = 0;
    try {
      expiresAt = parseJwtExpiry(acc.jwt);
    } catch {
      /* leave 0 — caller will refresh */
    }
    const migrated: EngramTokens = {
      jwt: acc.jwt,
      refreshToken: acc.refreshToken ?? '',
      apiKey: acc.apiKey,
      expiresAt,
    };
    log.info('Migrating engramAccount from config.json → oauth_tokens table');
    saveTokens(migrated);
    return migrated;
  } catch (e) {
    log.warn(
      `Token migration from config.json failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export function clearTokens(): void {
  getDb().prepare('DELETE FROM oauth_tokens WHERE provider = ?').run(PROVIDER);
  log.info('Engram account tokens cleared');
}

// ---------------------------------------------------------------------------
// JWT refresh
// ---------------------------------------------------------------------------

/**
 * Parse expiry from a JWT payload without verifying the signature.
 * The server will reject an expired JWT anyway; we just need the timing.
 */
export function parseJwtExpiry(jwt: string): number {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
    exp?: number;
  };
  if (!payload.exp) throw new Error('JWT has no exp claim');
  return payload.exp * 1000; // convert to Unix ms
}

/**
 * POST /auth/refresh to get a new JWT using the refresh token.
 * Plan I exposes this endpoint.
 */
async function refreshJwt(
  refreshToken: string,
  baseUrl: string,
): Promise<{ jwt: string; expiresAt: number }> {
  const url = `${baseUrl.replace(/\/$/, '')}/auth/refresh`;
  // pinnedFetch: defeats corporate MitM proxy that would otherwise steal
  // the refresh token (long-lived) and the new JWT we receive.
  const res = await pinnedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`JWT refresh failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { jwt?: string; token?: string };
  const newJwt = data.jwt ?? data.token ?? '';
  if (!newJwt) throw new Error('Refresh response missing jwt field');
  return { jwt: newJwt, expiresAt: parseJwtExpiry(newJwt) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a valid (non-expired) JWT. Refreshes automatically if needed.
 * Throws if tokens are not present or refresh fails.
 */
export async function getValidJwt(baseUrl: string): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not paired — run `engram-mcp-pair` to connect your account');

  const now = Date.now();
  if (tokens.expiresAt - now > REFRESH_BUFFER_MS) {
    // Still valid
    return tokens.jwt;
  }

  // Needs refresh
  log.info('JWT near expiry — refreshing');
  const { jwt, expiresAt } = await refreshJwt(tokens.refreshToken, baseUrl);
  saveTokens({ ...tokens, jwt, expiresAt });
  log.info('JWT refreshed successfully');
  return jwt;
}

/**
 * Return the stored API key. Throws if not paired.
 */
export function getApiKey(): string {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not paired — run `engram-mcp-pair` to connect your account');
  if (!tokens.apiKey) throw new Error('Paired but API key missing — re-pair to fix');
  return tokens.apiKey;
}

/**
 * Check whether the user has paired (tokens present in DB).
 */
export function isPaired(): boolean {
  return loadTokens() !== null;
}
