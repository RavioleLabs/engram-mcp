// GET /api/version — installed engram-mcp version + npm registry pointer.
// POST /api/update — one-click upgrade to the latest npm version + service
//   restart. Triggered from the dashboard's "Install update" button so the
//   user doesn't have to drop into a terminal. Sync (waits for npm to
//   finish, 2-min cap) — npm install is 30-60s typically.
//
// Security: the HTTP server only binds 127.0.0.1, so the update endpoint
// is unreachable from the network. Cloud-mediated calls arrive via the
// bridge, which is authenticated by the user's JWT — same trust boundary
// as every other write endpoint. We additionally pin the package name so
// a compromised relay can't redirect the install to a hostile fork.

import { spawn } from 'child_process';
import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../core/logger.js';

const log = createLogger('api:version');

const PACKAGE_NAME = '@raviolelabs/engram-mcp';
const NPM_REGISTRY = 'https://registry.npmjs.org/@raviolelabs/engram-mcp/latest';
const UPDATE_TIMEOUT_MS = 120_000;

let cachedVersion: string | null = null;

function loadVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of ['../../../package.json', '../../package.json', '../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(here, candidate), 'utf-8')) as {
          version?: string;
        };
        if (pkg.version) {
          cachedVersion = pkg.version;
          return cachedVersion;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr || 'spawn failed', timedOut: false });
    });
  });
}

// Best-effort service restart. On macOS the LaunchAgent exits when the
// current process does and respawns thanks to KeepAlive — so we just kill
// ourselves after a short delay so the in-flight HTTP response actually
// makes it back to the browser. systemd-user is the same idea.
function scheduleSelfRestart(): void {
  setTimeout(() => {
    log.info('Restarting engram-mcp after update — see LaunchAgent/systemd for the new process.');
    process.exit(0);
  }, 1500);
}

export function versionApi(): Router {
  const r = Router();

  r.get('/', (_req: Request, res: Response) => {
    res.json({
      version: loadVersion(),
      package: PACKAGE_NAME,
      registry_url: NPM_REGISTRY,
      changelog_url: 'https://github.com/RavioleLabs/engram-mcp/releases',
      update_command: `npm install -g ${PACKAGE_NAME}@latest`,
      can_self_update: true,
    });
  });

  r.post('/update', async (_req: Request, res: Response) => {
    const installed = loadVersion();
    const latest = await fetchLatestVersion();
    if (!latest) {
      res.status(502).json({ error: 'cannot_reach_npm', installed });
      return;
    }
    if (installed === latest) {
      res.json({ ok: true, already_latest: true, version: installed });
      return;
    }

    // Hard-pin the package name so a compromised relay can't redirect.
    log.info(`Update requested: ${installed} → ${latest}`);
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const installResult = await runCommand(
      npmCmd,
      ['install', '-g', `${PACKAGE_NAME}@${latest}`, '--no-audit', '--no-fund', '--loglevel=warn'],
      UPDATE_TIMEOUT_MS,
    );

    if (installResult.timedOut) {
      res.status(504).json({
        error: 'npm_install_timeout',
        installed,
        latest,
        stderr_tail: installResult.stderr.slice(-500),
      });
      return;
    }
    if (installResult.exitCode !== 0) {
      log.warn(`npm install failed (code ${installResult.exitCode})`);
      res.status(500).json({
        error: 'npm_install_failed',
        exit_code: installResult.exitCode,
        installed,
        latest,
        stderr_tail: installResult.stderr.slice(-500),
        stdout_tail: installResult.stdout.slice(-500),
      });
      return;
    }

    res.json({
      ok: true,
      installed_before: installed,
      installed_now: latest,
      restarting_in_ms: 1500,
      log_tail: installResult.stdout.slice(-300),
      restart_target:
        process.platform === 'darwin'
          ? 'LaunchAgent'
          : process.platform === 'linux'
          ? 'systemd-user'
          : os.platform(),
    });

    // After the response flushes, suicide so the service supervisor picks
    // up the freshly-installed binary.
    scheduleSelfRestart();
  });

  return r;
}
