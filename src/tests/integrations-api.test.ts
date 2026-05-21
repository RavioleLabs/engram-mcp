/**
 * Smoke test for integrations config read/write helpers.
 *
 * Uses a temp dir to test PATCH → GET status → DELETE flow without a running
 * HTTP server. We test the config file writing logic in isolation, verifying
 * that credentials persist, permissions are 0o600, and deletion works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// -- Inline the helpers from integrations.ts (avoids starting a full Express app) --

function getConfigPath(configDir: string): string {
  return path.join(configDir, 'config.json');
}

function readRawConfig(configDir: string): Record<string, unknown> {
  const p = getConfigPath(configDir);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfig(configDir: string, updated: Record<string, unknown>): void {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const configPath = getConfigPath(configDir);
  const tmpPath = configPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // non-fatal
  }
}

function getStatus(config: Record<string, unknown>) {
  const driveConf = config.drive as { clientId?: string; clientSecret?: string } | undefined;
  const notionConf = config.notion as { clientId?: string; clientSecret?: string } | undefined;
  return {
    drive: {
      configured: !!(driveConf?.clientId && driveConf?.clientSecret),
    },
    notion: {
      configured: !!(notionConf?.clientId && notionConf?.clientSecret),
    },
  };
}

// -----------------------------------------------------------------------

describe('integrations config helpers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-integrations-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns not-configured when no config exists', () => {
    const raw = readRawConfig(tmpDir);
    const status = getStatus(raw);
    expect(status.drive.configured).toBe(false);
    expect(status.notion.configured).toBe(false);
  });

  it('PATCH drive: writes credentials and returns configured=true', () => {
    const raw = readRawConfig(tmpDir);
    raw.drive = { clientId: 'test-client-id', clientSecret: 'test-secret', redirectPort: 7777 };
    writeConfig(tmpDir, raw);

    const after = readRawConfig(tmpDir);
    const status = getStatus(after);
    expect(status.drive.configured).toBe(true);
    expect(status.notion.configured).toBe(false);

    const drive = after.drive as { clientId: string; clientSecret: string };
    expect(drive.clientId).toBe('test-client-id');
    expect(drive.clientSecret).toBe('test-secret');
  });

  it('does not clobber other config keys when patching drive', () => {
    // Simulate existing embeddings config
    const initial = {
      dataDir: '~/.engram',
      embeddings: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 },
    } as Record<string, unknown>;
    writeConfig(tmpDir, initial);

    const raw = readRawConfig(tmpDir);
    raw.drive = { clientId: 'cid', clientSecret: 'csecret', redirectPort: 7777 };
    writeConfig(tmpDir, raw);

    const after = readRawConfig(tmpDir);
    const embeddings = after.embeddings as { provider: string };
    expect(embeddings.provider).toBe('ollama'); // not clobbered
    expect(getStatus(after).drive.configured).toBe(true);
  });

  it('DELETE drive: wipes credentials', () => {
    const raw = readRawConfig(tmpDir);
    raw.drive = { clientId: 'cid', clientSecret: 'csecret', redirectPort: 7777 };
    writeConfig(tmpDir, raw);

    const toDelete = readRawConfig(tmpDir);
    delete toDelete.drive;
    writeConfig(tmpDir, toDelete);

    const after = readRawConfig(tmpDir);
    expect(getStatus(after).drive.configured).toBe(false);
    expect(after.drive).toBeUndefined();
  });

  it('config.json has mode 0o600 after write', () => {
    writeConfig(tmpDir, { test: true });
    const configPath = getConfigPath(tmpDir);
    const stat = fs.statSync(configPath);
    // Mode bits: file type (0o100000) + permissions (0o600)
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('PATCH notion: writes notion credentials', () => {
    const raw = readRawConfig(tmpDir);
    raw.notion = { clientId: 'notion-cid', clientSecret: 'notion-secret', redirectPort: 7777 };
    writeConfig(tmpDir, raw);

    const after = readRawConfig(tmpDir);
    expect(getStatus(after).notion.configured).toBe(true);
  });

  it('atomic write: tmp file does not persist on success', () => {
    writeConfig(tmpDir, { ok: true });
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });
});
