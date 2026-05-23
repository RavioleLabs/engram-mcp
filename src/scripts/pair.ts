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

  // Load config to get dataDir
  const config = loadConfig();
  initDb(config.dataDir);

  if (config.engramAccount) {
    console.log('\n  Note: Re-pairing will replace existing tokens.\n');
  }

  // Start pairing flow — opens browser automatically
  let result: { jwt: string; refreshToken: string; apiKey: string; expiresAt: number };
  try {
    result = await startPairing({ baseUrl });
  } catch (e) {
    log.error(`Pairing failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`\n  Pairing failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
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

  console.log('\n  Paired successfully (api key stored locally)');
  console.log('  Bridge will connect on next engram-mcp start.');
  console.log(`\n  Open your dashboard: https://engram-mcp.com/dashboard\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
