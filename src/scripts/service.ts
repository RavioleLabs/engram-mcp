#!/usr/bin/env node
/**
 * engram-mcp-service — manage the EngramMCP background service.
 *
 * Usage:
 *   engram-mcp-service start
 *   engram-mcp-service stop
 *   engram-mcp-service restart
 *   engram-mcp-service status
 *   engram-mcp-service install
 *   engram-mcp-service uninstall
 *
 * Platform dispatch:
 *   macOS  — launchctl (~/Library/LaunchAgents/com.raviolelabs.engram-mcp.plist)
 *   Linux  — systemctl --user engram.service
 *   Windows — nssm (service name: EngramMCP)
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();
const PLATFORM = platform(); // 'darwin' | 'linux' | 'win32'
const LABEL = 'com.raviolelabs.engram-mcp';
// Legacy label "com.ravolelabs.engram" (typo, missing 'i') was used through
// v0.6.8. Tolerate it on status/restart and clean it up on install/uninstall.
const LEGACY_LABEL = 'com.ravolelabs.engram';
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LEGACY_PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
const SYSTEMD_PATH = join(HOME, '.config', 'systemd', 'user', 'engram.service');
const LOG_DIR = join(HOME, '.engram', 'logs');
const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'services',
);

// Resolve binary path: prefer the installed binary on PATH, fall back to dist/
function resolveBinaryPath(): string {
  const result = spawnSync('which', ['engram-mcp'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  // Windows
  const whereResult = spawnSync('where', ['engram-mcp.exe'], { encoding: 'utf8' });
  if (whereResult.status === 0 && whereResult.stdout.trim()) {
    return whereResult.stdout.trim().split('\n')[0]!.trim();
  }
  // Fallback: assume dist/scripts/serve.js is the entry in the monorepo
  return join(HOME, '.local', 'bin', 'engram-mcp');
}

// ── Platform helpers ─────────────────────────────────────────────────────────

function run(cmd: string, opts: { silent?: boolean } = {}): boolean {
  try {
    execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function templateSubstitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

// ── macOS (launchctl) ────────────────────────────────────────────────────────

function macosCleanupLegacy(): void {
  if (existsSync(LEGACY_PLIST_PATH)) {
    run(`launchctl bootout "gui/$(id -u)" "${LEGACY_PLIST_PATH}" 2>/dev/null || true`, {
      silent: true,
    });
    run(`launchctl unload "${LEGACY_PLIST_PATH}" 2>/dev/null || true`, { silent: true });
    try {
      unlinkSync(LEGACY_PLIST_PATH);
      console.log(`Removed legacy LaunchAgent (${LEGACY_LABEL})`);
    } catch {
      /* already gone */
    }
  }
}

const macos = {
  install(): void {
    macosCleanupLegacy();
    const binaryPath = resolveBinaryPath();
    const templatePath = join(TEMPLATE_DIR, 'engram.plist.template');
    if (!existsSync(templatePath)) {
      console.error(`Template not found: ${templatePath}`);
      process.exit(1);
    }
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(dirname(PLIST_PATH), { recursive: true });
    const plist = templateSubstitute(readFileSync(templatePath, 'utf8'), {
      BINARY_PATH: binaryPath,
      HOME,
    });
    writeFileSync(PLIST_PATH, plist, 'utf8');
    console.log(`Plist written: ${PLIST_PATH}`);
    run(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
    run(`launchctl load -w "${PLIST_PATH}"`);
    console.log('LaunchAgent loaded. EngramMCP will start on login.');
  },

  start(): void {
    if (!existsSync(PLIST_PATH)) {
      console.log('Service not installed. Run: engram-mcp-service install');
      process.exit(1);
    }
    run(`launchctl start ${LABEL}`);
    console.log('Service started.');
  },

  stop(): void {
    run(`launchctl stop ${LABEL}`);
    console.log('Service stopped.');
  },

  restart(): void {
    macos.stop();
    macos.start();
  },

  status(): void {
    const ok = run(`launchctl list | grep -E "${LABEL}|${LEGACY_LABEL}"`, { silent: false });
    if (!ok) console.log('Service not running (not found in launchctl list).');
  },

  uninstall(): void {
    run(`launchctl unload -w "${PLIST_PATH}" 2>/dev/null || true`);
    if (existsSync(PLIST_PATH)) {
      run(`rm -f "${PLIST_PATH}"`);
      console.log(`Removed ${PLIST_PATH}`);
    }
    macosCleanupLegacy();
    console.log('LaunchAgent removed. EngramMCP will no longer start on login.');
  },
};

// ── Linux (systemctl --user) ─────────────────────────────────────────────────

const linux = {
  install(): void {
    const binaryPath = resolveBinaryPath();
    const templatePath = join(TEMPLATE_DIR, 'engram.service.template');
    if (!existsSync(templatePath)) {
      console.error(`Template not found: ${templatePath}`);
      process.exit(1);
    }
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(dirname(SYSTEMD_PATH), { recursive: true });
    const unit = templateSubstitute(readFileSync(templatePath, 'utf8'), {
      BINARY_PATH: binaryPath,
      HOME,
    });
    writeFileSync(SYSTEMD_PATH, unit, 'utf8');
    console.log(`Unit written: ${SYSTEMD_PATH}`);
    run('systemctl --user daemon-reload');
    run('systemctl --user enable --now engram.service');
    console.log('systemd user service enabled. EngramMCP will start on login.');
  },

  start(): void {
    run('systemctl --user start engram.service');
    console.log('Service started.');
  },

  stop(): void {
    run('systemctl --user stop engram.service');
    console.log('Service stopped.');
  },

  restart(): void {
    run('systemctl --user restart engram.service');
    console.log('Service restarted.');
  },

  status(): void {
    run('systemctl --user status engram.service');
  },

  uninstall(): void {
    run('systemctl --user disable --now engram.service');
    if (existsSync(SYSTEMD_PATH)) {
      run(`rm -f "${SYSTEMD_PATH}"`);
      console.log(`Removed ${SYSTEMD_PATH}`);
    }
    run('systemctl --user daemon-reload');
    console.log('systemd user service removed.');
  },
};

// ── Windows (NSSM) ───────────────────────────────────────────────────────────

const SERVICE_NAME = 'EngramMCP';

const windows = {
  requireNssm(): string {
    const result = spawnSync('nssm', ['version'], { encoding: 'utf8' });
    if (result.status === 0) return 'nssm';
    // Check common install path
    const candidate = 'C:\\nssm\\nssm.exe';
    if (existsSync(candidate)) return candidate;
    console.error(
      'NSSM not found. Install from https://nssm.cc/download and add to PATH, or run install.ps1 again.',
    );
    process.exit(1);
  },

  install(): void {
    const nssm = windows.requireNssm();
    const binary = resolveBinaryPath();
    const logDir = join(HOME, '.engram', 'logs');
    mkdirSync(logDir, { recursive: true });

    run(`"${nssm}" stop "${SERVICE_NAME}" 2>nul`);
    run(`"${nssm}" remove "${SERVICE_NAME}" confirm 2>nul`);
    run(`"${nssm}" install "${SERVICE_NAME}" "${binary}"`);
    run(`"${nssm}" set "${SERVICE_NAME}" AppStdout "${join(logDir, 'engram.log')}"`);
    run(`"${nssm}" set "${SERVICE_NAME}" AppStderr "${join(logDir, 'engram.err')}"`);
    run(`"${nssm}" set "${SERVICE_NAME}" AppRotateFiles 1`);
    run(`"${nssm}" set "${SERVICE_NAME}" AppRotateBytes 10485760`);
    run(`"${nssm}" set "${SERVICE_NAME}" Start SERVICE_AUTO_START`);
    run(`"${nssm}" start "${SERVICE_NAME}"`);
    console.log(`Windows service '${SERVICE_NAME}' installed and started.`);
  },

  start(): void {
    const nssm = windows.requireNssm();
    run(`"${nssm}" start "${SERVICE_NAME}"`);
    console.log('Service started.');
  },

  stop(): void {
    const nssm = windows.requireNssm();
    run(`"${nssm}" stop "${SERVICE_NAME}"`);
    console.log('Service stopped.');
  },

  restart(): void {
    const nssm = windows.requireNssm();
    run(`"${nssm}" restart "${SERVICE_NAME}"`);
    console.log('Service restarted.');
  },

  status(): void {
    const nssm = windows.requireNssm();
    run(`"${nssm}" status "${SERVICE_NAME}"`);
  },

  uninstall(): void {
    const nssm = windows.requireNssm();
    run(`"${nssm}" stop "${SERVICE_NAME}"`);
    run(`"${nssm}" remove "${SERVICE_NAME}" confirm`);
    console.log(`Windows service '${SERVICE_NAME}' removed.`);
  },
};

// ── Dispatch ─────────────────────────────────────────────────────────────────

type Action = 'start' | 'stop' | 'restart' | 'status' | 'install' | 'uninstall';

const VALID_ACTIONS: Action[] = ['start', 'stop', 'restart', 'status', 'install', 'uninstall'];

const action = process.argv[2] as Action | undefined;

if (!action || !VALID_ACTIONS.includes(action)) {
  console.error(`Usage: engram-mcp-service <${VALID_ACTIONS.join('|')}>`);
  process.exit(1);
}

function dispatch(impl: typeof macos | typeof linux | typeof windows): void {
  switch (action) {
    case 'start':
      impl.start();
      break;
    case 'stop':
      impl.stop();
      break;
    case 'restart':
      impl.restart();
      break;
    case 'status':
      impl.status();
      break;
    case 'install':
      impl.install();
      break;
    case 'uninstall':
      impl.uninstall();
      break;
  }
}

switch (PLATFORM) {
  case 'darwin':
    dispatch(macos);
    break;
  case 'linux':
    dispatch(linux);
    break;
  case 'win32':
    dispatch(windows);
    break;
  default:
    console.error(`Unsupported platform: ${PLATFORM}`);
    process.exit(1);
}
