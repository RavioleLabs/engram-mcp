import http from 'http';
import { URL } from 'url';
import { getDb } from '../../../db/index.js';
import { createLogger } from '../../../logger.js';
import type { EngramConfig } from '../../../config/schema.js';

const log = createLogger('drive:oauth');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

export interface DriveTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
}

function loadTokens(): DriveTokens | undefined {
  const row = getDb()
    .prepare(
      `SELECT access_token, refresh_token, expires_at, extra_json
       FROM oauth_tokens WHERE provider = 'drive'`,
    )
    .get() as
    | {
        access_token: string;
        refresh_token: string | null;
        expires_at: number | null;
        extra_json: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token ?? undefined,
    expires_at: row.expires_at ?? 0,
    scope: (row.extra_json && JSON.parse(row.extra_json).scope) || SCOPES.join(' '),
  };
}

function saveTokens(t: DriveTokens): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO oauth_tokens
         (provider, access_token, refresh_token, expires_at, extra_json, updated_at)
       VALUES ('drive', ?, ?, ?, ?, ?)`,
    )
    .run(
      t.access_token,
      t.refresh_token ?? null,
      t.expires_at,
      JSON.stringify({ scope: t.scope }),
      Date.now(),
    );
}

export async function startDriveOAuthFlow(
  config: EngramConfig,
): Promise<{ authUrl: string; waitForCallback: Promise<DriveTokens> }> {
  if (!config.drive) throw new Error('drive.clientId/clientSecret not configured');
  const { clientId, clientSecret, redirectPort } = config.drive;
  const redirectUri = `http://localhost:${redirectPort}/oauth/callback/drive`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const waitForCallback = new Promise<DriveTokens>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth/callback/drive')) {
        res.writeHead(404).end();
        return;
      }
      const u = new URL(req.url, `http://localhost:${redirectPort}`);
      const code = u.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('Missing code');
        return;
      }
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });
        if (!tokenRes.ok) {
          const txt = await tokenRes.text();
          throw new Error(`Token exchange failed: ${tokenRes.status} ${txt.slice(0, 200)}`);
        }
        const data = (await tokenRes.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
          scope: string;
        };
        const tokens: DriveTokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + data.expires_in * 1000,
          scope: data.scope,
        };
        saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Connected to Google Drive. You can close this tab.</h2></body></html>',
        );
        server.close();
        log.info('Drive OAuth completed');
        resolve(tokens);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500).end(`Error: ${msg}`);
        server.close();
        reject(e);
      }
    });
    server.listen(redirectPort, () => {
      log.info(`OAuth callback server listening on :${redirectPort}`);
    });
  });

  return { authUrl: authUrl.toString(), waitForCallback };
}

export async function getValidAccessToken(config: EngramConfig): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Drive not connected — run connect_drive first');
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('Drive access token expired and no refresh token');
  if (!config.drive) throw new Error('drive client not configured');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: config.drive.clientId,
      client_secret: config.drive.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const newTokens: DriveTokens = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: tokens.scope,
  };
  saveTokens(newTokens);
  return newTokens.access_token;
}

export function isDriveConnected(): boolean {
  return !!loadTokens();
}
