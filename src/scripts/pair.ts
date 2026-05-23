#!/usr/bin/env node
/**
 * src/scripts/pair.ts
 *
 * CLI entry for `engram-mcp-pair`.
 * One-click browser-based pairing flow — no interactive prompts.
 *
 * Usage:
 *   engram-mcp pair
 *   ENGRAM_PAIR_AUTO=1 engram-mcp pair   # silent mode (used by install.sh)
 *   engram-mcp pair --base-url https://api.engram-mcp.com
 *
 * After pairing:
 * - JWT + refresh token + API key saved in config.json under engramAccount
 * - The bridge relay + transit poller activate automatically on next start
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../config/index.js';
import { initDb } from '../db/index.js';
import { startPairing } from '../cloud/pairing.js';
import { generateMasterKeySalt } from '../cloud/crypto.js';
import { createLogger } from '../logger.js';

const log = createLogger('pair-cli');

const ENGRAM_DIR = path.join(os.homedir(), '.engram');
const CONFIG_PATH = path.join(ENGRAM_DIR, 'config.json');

async function main() {
  // Parse --base-url flag
  const baseUrlArg = process.argv.indexOf('--base-url');
  const baseUrl = baseUrlArg !== -1 ? process.argv[baseUrlArg + 1] : 'https://engram-mcp.com';
  const apiBaseUrl =
    baseUrlArg !== -1
      ? process.argv[baseUrlArg + 1]?.replace('engram-mcp.com', 'api.engram-mcp.com') ??
        'https://api.engram-mcp.com'
      : 'https://api.engram-mcp.com';

  // --token <TOKEN> short-circuit: skip the browser callback flow and redeem
  // an invite token directly. This is what the dashboard surfaces when a user
  // already has engram-mcp installed and just wants to re-pair after a revoke.
  const tokenArg = process.argv.indexOf('--token');
  const inviteToken =
    tokenArg !== -1 ? process.argv[tokenArg + 1] : process.env.ENGRAM_INVITE_TOKEN || null;

  // Load config to get dataDir
  const config = loadConfig();
  initDb(config.dataDir);

  if (config.engramAccount) {
    console.log('\n  Note: Re-pairing will replace existing tokens.\n');
  }

  let result: { jwt: string; refreshToken: string; apiKey: string; expiresAt: number };

  if (inviteToken) {
    // Direct redemption — same endpoint install.sh hits at step 8
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(inviteToken)) {
      console.error('\n  Invalid token format (expected 6-32 url-safe chars)\n');
      process.exit(1);
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/pair/redeem-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`\n  Redeem failed (HTTP ${res.status}): ${body.slice(0, 200)}\n`);
        process.exit(1);
      }
      const data = (await res.json()) as {
        jwt: string;
        refresh_token: string;
        api_key: string;
        expires_at?: number;
        user?: { email?: string };
      };
      if (!data.jwt || !data.api_key) {
        console.error('\n  Redeem response missing tokens\n');
        process.exit(1);
      }
      result = {
        jwt: data.jwt,
        refreshToken: data.refresh_token,
        apiKey: data.api_key,
        expiresAt: data.expires_at ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
      console.log(`\n  ✓ Linked to ${data.user?.email ?? 'your account'}`);
    } catch (e) {
      console.error(`\n  Pairing failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  } else {
    // Interactive browser flow (kept for users who run `engram-mcp pair`
    // without any args — same UX as install.sh's initial pair step).
    try {
      result = await startPairing({ baseUrl });
    } catch (e) {
      log.error(`Pairing failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`\n  Pairing failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  // Generate or reuse master key salt
  const existingSalt = config.engramAccount?.masterKeySalt;
  const masterKeySalt = existingSalt ?? (await generateMasterKeySalt());

  // Update config.json
  const updatedConfig = {
    ...config,
    engramAccount: {
      jwt: result.jwt,
      refreshToken: result.refreshToken,
      apiKey: result.apiKey,
      masterKeySalt,
      baseUrl: apiBaseUrl,
      pairedAt: new Date().toISOString(),
    },
  };

  fs.mkdirSync(ENGRAM_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);

  console.log('\n  ✓ Paired successfully (tokens saved to ~/.engram/config.json)');

  // Restart the service so the bridge picks up the fresh tokens. Without
  // this the user has to manually kickstart, which defeats the one-command
  // re-pair UX.
  try {
    const { spawnSync } = await import('node:child_process');
    if (process.platform === 'darwin') {
      const uid = process.getuid?.() ?? 0;
      const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/com.ravolelabs.engram`]);
      if (r.status === 0) console.log('  ✓ Restarted background service — bridge now connecting');
    } else if (process.platform === 'linux') {
      const r = spawnSync('systemctl', ['--user', 'restart', 'engram.service']);
      if (r.status === 0) console.log('  ✓ Restarted background service — bridge now connecting');
    }
  } catch {
    console.log('  (Bridge will connect on next engram-mcp start.)');
  }

  console.log(`\n  Open your dashboard: https://engram-mcp.com/dashboard\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
