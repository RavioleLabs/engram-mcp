import http from 'http';
import { URL } from 'url';
import { getDb } from '../../../db/index.js';
import { createLogger } from '../../../logger.js';
import { decryptSecret } from '../../../core/secret-vault.js';
import type { EngramConfig } from '../../../config/schema.js';

const log = createLogger('notion:oauth');

export interface NotionTokens {
  access_token: string;
  bot_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_icon?: string;
}

function loadTokens(): NotionTokens | undefined {
  const row = getDb()
    .prepare(`SELECT access_token, extra_json FROM oauth_tokens WHERE provider = 'notion'`)
    .get() as { access_token: string; extra_json: string | null } | undefined;
  if (!row) return undefined;
  const extra = row.extra_json ? JSON.parse(row.extra_json) : {};
  return {
    access_token: row.access_token,
    bot_id: extra.bot_id ?? '',
    workspace_id: extra.workspace_id ?? '',
    workspace_name: extra.workspace_name ?? '',
    workspace_icon: extra.workspace_icon,
  };
}

function saveTokens(t: NotionTokens): void {
  const extra = {
    bot_id: t.bot_id,
    workspace_id: t.workspace_id,
    workspace_name: t.workspace_name,
    workspace_icon: t.workspace_icon,
  };
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO oauth_tokens
         (provider, access_token, refresh_token, expires_at, extra_json, updated_at)
       VALUES ('notion', ?, NULL, NULL, ?, ?)`,
    )
    .run(t.access_token, JSON.stringify(extra), Date.now());
}

export function isNotionConnected(): boolean {
  return !!loadTokens();
}

export function getNotionToken(): string {
  const t = loadTokens();
  if (!t) throw new Error('Notion not connected — run connect_notion first');
  return t.access_token;
}

export function getNotionWorkspace(): { id: string; name: string } | undefined {
  const t = loadTokens();
  if (!t) return undefined;
  return { id: t.workspace_id, name: t.workspace_name };
}

export async function startNotionOAuthFlow(
  config: EngramConfig,
): Promise<{ authUrl: string; waitForCallback: Promise<NotionTokens> }> {
  if (!config.notion) throw new Error('notion.clientId/clientSecret not configured');
  const { clientId, redirectPort } = config.notion;
  // SECURITY: see drive/oauth.ts — decrypt at use, never log plaintext.
  const clientSecret = await decryptSecret(config.notion.clientSecret);
  const redirectUri = `http://localhost:${redirectPort}/oauth/callback/notion`;

  const authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('owner', 'user');

  const waitForCallback = new Promise<NotionTokens>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth/callback/notion')) {
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
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${basic}`,
          },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
          }),
        });
        if (!tokenRes.ok) {
          const txt = await tokenRes.text();
          throw new Error(`Notion token exchange failed: ${tokenRes.status} ${txt.slice(0, 300)}`);
        }
        const data = (await tokenRes.json()) as {
          access_token: string;
          bot_id: string;
          workspace_id: string;
          workspace_name: string;
          workspace_icon?: string;
        };
        const tokens: NotionTokens = {
          access_token: data.access_token,
          bot_id: data.bot_id,
          workspace_id: data.workspace_id,
          workspace_name: data.workspace_name,
          workspace_icon: data.workspace_icon,
        };
        saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body><h2>Connected to Notion workspace: ${tokens.workspace_name}.</h2><p>You can close this tab.</p></body></html>`,
        );
        server.close();
        log.info(`Notion OAuth completed for workspace ${tokens.workspace_name}`);
        resolve(tokens);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500).end(`Error: ${msg}`);
        server.close();
        reject(e);
      }
    });
    server.listen(redirectPort, () => {
      log.info(`Notion OAuth callback server listening on :${redirectPort}`);
    });
  });

  return { authUrl: authUrl.toString(), waitForCallback };
}
