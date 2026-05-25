#!/usr/bin/env node
// Interactive setup wizard for Google Drive OAuth credentials.
//
// Background: connect_drive() returns drive_not_configured when the user has
// not put OAuth client_id + client_secret in ~/.engram/config.json. Drive's
// own OAuth model requires per-app credentials — there is no Engram-shipped
// default. The stress test (specs/2026-05-24-engram-stress-test.md §P7) called
// this a UX blocker. This script walks the user through the Google Cloud
// Console steps and patches the config in place — no JSON editing required.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline/promises';
import { spawn } from 'child_process';
import { defaultConfig, type EngramConfig } from '../config/schema.js';

const ENGRAM_DIR = path.join(os.homedir(), '.engram');
const CONFIG_PATH = path.join(ENGRAM_DIR, 'config.json');
const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

async function main() {
  console.log('\n  EngramMCP — Google Drive OAuth setup\n');

  if (!fs.existsSync(ENGRAM_DIR)) {
    fs.mkdirSync(ENGRAM_DIR, { recursive: true, mode: 0o700 });
  }

  // Load (or initialize) the config so we patch in place.
  let cfg: EngramConfig;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as EngramConfig;
    } catch (e) {
      console.error(
        `✗ Could not parse ${CONFIG_PATH}: ${e instanceof Error ? e.message : e}\n` +
          `  Fix the JSON and re-run.`,
      );
      process.exit(1);
    }
  } else {
    cfg = { ...defaultConfig };
  }

  if (cfg.drive?.clientId && cfg.drive?.clientSecret) {
    const rlCheck = createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = (
      await rlCheck.question(
        '? Drive credentials already configured in config.json. Overwrite? [y/N] ',
      )
    )
      .trim()
      .toLowerCase();
    rlCheck.close();
    if (overwrite !== 'y' && overwrite !== 'yes') {
      console.log('Aborted. Existing credentials kept.');
      process.exit(0);
    }
  }

  console.log('To connect Google Drive, EngramMCP needs an OAuth client (free).');
  console.log('Steps:');
  console.log('  1. Open the Google Cloud Console credentials page (link below)');
  console.log('  2. Create / pick a project');
  console.log('  3. + CREATE CREDENTIALS → OAuth client ID');
  console.log('  4. Application type: "Desktop app"  (simplest)');
  console.log('  5. Name it "EngramMCP" — Save');
  console.log('  6. Copy the Client ID and Client Secret shown in the dialog');
  console.log(`\n  ${CONSOLE_URL}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const wantOpen = (await rl.question('? Open the credentials page in your browser now? [Y/n] '))
    .trim()
    .toLowerCase();
  if (wantOpen === '' || wantOpen === 'y' || wantOpen === 'yes') {
    openInBrowser(CONSOLE_URL);
  }

  const clientId = (await rl.question('? Paste the Client ID: ')).trim();
  if (!clientId) {
    console.error('✗ Client ID is required. Aborting.');
    rl.close();
    process.exit(1);
  }

  const clientSecret = (await rl.question('? Paste the Client Secret: ')).trim();
  if (!clientSecret) {
    console.error('✗ Client Secret is required. Aborting.');
    rl.close();
    process.exit(1);
  }

  rl.close();

  cfg.drive = {
    clientId,
    clientSecret,
    redirectPort: cfg.drive?.redirectPort ?? 7777,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);

  console.log(`\n✓ Saved Drive credentials to ${CONFIG_PATH}`);
  console.log('\nNext steps:');
  console.log('  1. Restart engram-mcp if it is running (so it picks up the new config)');
  console.log('  2. From your agent, call connect_drive() — you will get an auth_url');
  console.log('  3. Open the auth_url, grant access — Drive is then ready');
  console.log('  4. Use list_drive_files(), ingest("https://drive.google.com/..."), or watch()\n');
}

function openInBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const proc = spawn(opener, [url], { stdio: 'ignore', detached: true });
    proc.unref();
  } catch {
    console.log(`(Could not auto-open browser. Visit ${url} manually.)`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
