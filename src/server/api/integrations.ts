// src/server/api/integrations.ts
//
// REST endpoints for Drive/Notion integration setup.
// Keys are written to ~/.engram/config.json — the cloud never sees them.
//
// Routes:
//   GET  /api/integrations/status
//   PATCH /api/integrations/drive
//   PATCH /api/integrations/notion
//   DELETE /api/integrations/drive
//   DELETE /api/integrations/notion
//   POST /api/integrations/drive/connect
//   POST /api/integrations/notion/connect

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import { createLogger } from '../../logger.js';
import { isDriveConnected, startDriveOAuthFlow } from '../../memory/modules/drive/oauth.js';
import { isNotionConnected, startNotionOAuthFlow } from '../../memory/modules/notion/oauth.js';
import { EngramConfigSchema } from '../../config/schema.js';
import type { EngramConfig } from '../../config/schema.js';

const log = createLogger('api:integrations');

// ---------------------------------------------------------------------------
// Config path helpers
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  const raw = process.env.ENGRAM_CONFIG_DIR ?? path.join(os.homedir(), '.engram');
  if (raw.startsWith('~')) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

function readRawConfig(): Record<string, unknown> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Atomically write config: tmp file → rename.
 * Sets permissions to 0o600 (owner read/write only — contains secrets).
 */
function writeConfig(updated: Record<string, unknown>): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const configPath = getConfigPath();
  const tmpPath = configPath + '.tmp.' + process.pid;
  const serialized = JSON.stringify(updated, null, 2);
  fs.writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  // Ensure 600 even if file already existed with different perms
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // non-fatal on systems where chmod isn't supported
  }
  log.info('config.json updated');
}

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------

function getStatus(config: Record<string, unknown>): {
  drive: { configured: boolean; connected: boolean };
  notion: { configured: boolean; connected: boolean };
} {
  const driveConf = config.drive as { clientId?: string; clientSecret?: string } | undefined;
  const notionConf = config.notion as { clientId?: string; clientSecret?: string } | undefined;
  return {
    drive: {
      configured: !!(driveConf?.clientId && driveConf?.clientSecret),
      connected: isDriveConnected(),
    },
    notion: {
      configured: !!(notionConf?.clientId && notionConf?.clientSecret),
      connected: isNotionConnected(),
    },
  };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CredentialsSchema = z.object({
  clientId: z.string().min(1, 'clientId required'),
  clientSecret: z.string().min(1, 'clientSecret required'),
  redirectPort: z.number().int().positive().default(7777),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function integrationsApi(getConfig: () => EngramConfig): Router {
  const r = Router();

  // GET /api/integrations/status
  r.get('/status', (_req, res) => {
    try {
      const raw = readRawConfig();
      res.json(getStatus(raw));
    } catch (e) {
      log.error(`GET /status error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  // PATCH /api/integrations/drive
  r.patch('/drive', (req, res) => {
    try {
      const parsed = CredentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const raw = readRawConfig();
      raw.drive = {
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
        redirectPort: parsed.data.redirectPort,
      };
      writeConfig(raw);
      res.json(getStatus(raw));
    } catch (e) {
      log.error(`PATCH /drive error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  // PATCH /api/integrations/notion
  r.patch('/notion', (req, res) => {
    try {
      const parsed = CredentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const raw = readRawConfig();
      raw.notion = {
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
        redirectPort: parsed.data.redirectPort,
      };
      writeConfig(raw);
      res.json(getStatus(raw));
    } catch (e) {
      log.error(`PATCH /notion error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  // DELETE /api/integrations/drive
  r.delete('/drive', (_req, res) => {
    try {
      const raw = readRawConfig();
      delete raw.drive;
      writeConfig(raw);
      res.json(getStatus(raw));
    } catch (e) {
      log.error(`DELETE /drive error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  // DELETE /api/integrations/notion
  r.delete('/notion', (_req, res) => {
    try {
      const raw = readRawConfig();
      delete raw.notion;
      writeConfig(raw);
      res.json(getStatus(raw));
    } catch (e) {
      log.error(`DELETE /notion error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/integrations/drive/connect
  r.post('/drive/connect', async (_req, res) => {
    try {
      const config = getConfig();
      if (!config.drive) {
        res.status(400).json({ error: 'Drive credentials not configured. PATCH /api/integrations/drive first.' });
        return;
      }
      const flow = await startDriveOAuthFlow(config);
      // Don't await the callback here — just return the URL so the browser can open it
      res.json({
        auth_url: flow.authUrl,
        instructions: 'Open the auth_url in your browser and authorize access. Poll GET /api/integrations/status until drive.connected becomes true.',
      });
      // Background: resolve and discard (tokens saved to DB by oauth.ts)
      flow.waitForCallback.catch((e: unknown) => {
        log.warn(`Drive OAuth callback error: ${e instanceof Error ? e.message : String(e)}`);
      });
    } catch (e) {
      log.error(`POST /drive/connect error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/integrations/notion/connect
  r.post('/notion/connect', async (_req, res) => {
    try {
      const config = getConfig();
      if (!config.notion) {
        res.status(400).json({ error: 'Notion credentials not configured. PATCH /api/integrations/notion first.' });
        return;
      }
      const flow = await startNotionOAuthFlow(config);
      res.json({
        auth_url: flow.authUrl,
        instructions: 'Open the auth_url in your browser and authorize access. Poll GET /api/integrations/status until notion.connected becomes true.',
      });
      flow.waitForCallback.catch((e: unknown) => {
        log.warn(`Notion OAuth callback error: ${e instanceof Error ? e.message : String(e)}`);
      });
    } catch (e) {
      log.error(`POST /notion/connect error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  return r;
}
