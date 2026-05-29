#!/usr/bin/env node
// engram-mcp doctor — health check / install diagnostic.
//
// Prints a concise status of the local install: version, config, service
// state, Ollama reachability, embedding model availability, vector store
// dim consistency, latest npm version. Each check has a clear PASS / WARN
// / FAIL marker so a user pasting the output into a support thread tells
// us exactly what to look at.
//
// Adapted to be safe to run while engram-mcp itself is running — no
// writes, no DB locks taken. Only reads config + checks HTTP endpoints.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

const ENGRAM_DIR = path.join(os.homedir(), '.engram');
const CONFIG_PATH = path.join(ENGRAM_DIR, 'config.json');
const VECTORS_DIR = path.join(ENGRAM_DIR, 'vectors');

const C = {
  pass: '\x1b[32m✓\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  fail: '\x1b[31m✗\x1b[0m',
  info: '\x1b[2m·\x1b[0m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

interface CheckResult {
  ok: 'pass' | 'warn' | 'fail';
  label: string;
  detail?: string;
  hint?: string;
}

function row(r: CheckResult): void {
  const mark = r.ok === 'pass' ? C.pass : r.ok === 'warn' ? C.warn : C.fail;
  const detail = r.detail ? `  ${C.dim}${r.detail}${C.reset}` : '';
  console.log(`  ${mark} ${r.label}${detail}`);
  if (r.hint && r.ok !== 'pass') {
    console.log(`      ${C.dim}↳ ${r.hint}${C.reset}`);
  }
}

function section(title: string): void {
  console.log(`\n${C.bold}${title}${C.reset}`);
}

function readPackageVersion(): string | null {
  try {
    // Resolve from the installed dist (this script runs from dist/scripts/).
    const here = path.dirname(new URL(import.meta.url).pathname);
    for (const candidate of ['../../package.json', '../package.json', '../../../package.json']) {
      const p = path.join(here, candidate);
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function fetchLatestNpm(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@raviolelabs/engram-mcp/latest', {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

async function httpReachable(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function ollamaListModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  } catch {
    return null;
  }
}

function platform(): 'darwin' | 'linux' | 'win32' | 'other' {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return 'other';
}

function launchAgentRunning(): { running: boolean; label: string | null; pid: string | null } {
  if (platform() !== 'darwin') return { running: false, label: null, pid: null };
  const out = spawnSync('launchctl', ['list'], { encoding: 'utf-8' });
  if (out.status !== 0) return { running: false, label: null, pid: null };
  for (const line of out.stdout.split('\n')) {
    if (/ravolelabs\.engram|raviolelabs\.engram-mcp/.test(line)) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const label = parts[parts.length - 1];
      return { running: pid !== '-', label, pid: pid === '-' ? null : pid };
    }
  }
  return { running: false, label: null, pid: null };
}

function systemdUserRunning(): boolean {
  if (platform() !== 'linux') return false;
  const out = spawnSync('systemctl', ['--user', 'is-active', 'engram-mcp.service'], {
    encoding: 'utf-8',
  });
  return out.stdout.trim() === 'active';
}

interface VectorMeta {
  tables: string[];
  firstTableDim: number | null;
}

async function inspectVectorStore(): Promise<VectorMeta | null> {
  if (!fs.existsSync(VECTORS_DIR)) return null;
  try {
    const lancedb = (await import('@lancedb/lancedb').catch(() => null)) as
      | typeof import('@lancedb/lancedb')
      | null;
    if (!lancedb) return null;
    const db = await lancedb.connect(VECTORS_DIR);
    const tables = await db.tableNames();
    let firstTableDim: number | null = null;
    for (const t of tables) {
      try {
        const table = await db.openTable(t);
        const rows = await table.query().limit(1).toArray();
        if (rows.length > 0) {
          const v = (rows[0] as Record<string, unknown>).vector;
          if (Array.isArray(v)) {
            firstTableDim = v.length;
            break;
          }
          if (v && typeof v === 'object' && 'length' in v) {
            firstTableDim = (v as { length: number }).length;
            break;
          }
        }
      } catch {
        /* skip empty / unreadable tables */
      }
    }
    return { tables, firstTableDim };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`\n${C.bold}EngramMCP — doctor${C.reset}\n`);

  const installed = readPackageVersion();

  section('Install');
  row({
    ok: installed ? 'pass' : 'fail',
    label: 'engram-mcp installed',
    detail: installed ?? 'package.json not found',
  });

  if (installed) {
    const latest = await fetchLatestNpm();
    if (latest) {
      const same = latest === installed;
      row({
        ok: same ? 'pass' : 'warn',
        label: 'latest npm version',
        detail: same ? installed : `${installed} → ${latest} available`,
        hint: same
          ? undefined
          : 'Run `engram-mcp self-update` (or click Install update in dashboard).',
      });
    } else {
      row({
        ok: 'warn',
        label: 'latest npm version',
        detail: 'npm registry unreachable (offline?)',
      });
    }
  }

  // Config
  section('Config');
  if (!fs.existsSync(ENGRAM_DIR)) {
    row({
      ok: 'fail',
      label: 'data dir',
      detail: `${ENGRAM_DIR} missing`,
      hint: 'Run the installer again.',
    });
  } else {
    row({ ok: 'pass', label: 'data dir', detail: ENGRAM_DIR });
  }

  let cfg: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      row({ ok: 'pass', label: 'config.json', detail: CONFIG_PATH });
    } catch (e) {
      row({
        ok: 'fail',
        label: 'config.json',
        detail: `unparseable: ${e instanceof Error ? e.message : e}`,
        hint: 'Fix the JSON or remove the file (defaults will be applied).',
      });
    }
  } else {
    row({ ok: 'warn', label: 'config.json', detail: 'missing — using defaults' });
  }

  const embeddings = (cfg.embeddings ?? {}) as {
    provider?: string;
    model?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  const provider = embeddings.provider ?? 'ollama';
  const model = embeddings.model ?? 'nomic-embed-text';
  const dimensions = embeddings.dimensions ?? 768;
  row({
    ok: 'pass',
    label: 'embedding config',
    detail: `provider=${provider}, model=${model}, dim=${dimensions}`,
  });

  // Service
  section('Service');
  const plat = platform();
  if (plat === 'darwin') {
    const la = launchAgentRunning();
    if (la.running && la.pid) {
      row({ ok: 'pass', label: 'LaunchAgent', detail: `${la.label} (pid ${la.pid})` });
    } else if (la.label) {
      row({
        ok: 'fail',
        label: 'LaunchAgent',
        detail: `${la.label} loaded but not running`,
        hint: 'launchctl kickstart -k gui/$(id -u)/' + la.label,
      });
    } else {
      row({
        ok: 'fail',
        label: 'LaunchAgent',
        detail: 'not registered',
        hint: 'Re-run the installer or `engram-mcp service install`.',
      });
    }
  } else if (plat === 'linux') {
    const active = systemdUserRunning();
    row({
      ok: active ? 'pass' : 'fail',
      label: 'systemd-user engram-mcp.service',
      detail: active ? 'active' : 'inactive',
      hint: active ? undefined : 'systemctl --user start engram-mcp.service',
    });
  } else {
    row({
      ok: 'info' as 'warn',
      label: 'service supervision',
      detail: `unsupported on ${process.platform}`,
    });
  }

  const httpReachableNow = await httpReachable('http://127.0.0.1:7777/api/version');
  row({
    ok: httpReachableNow ? 'pass' : 'warn',
    label: 'HTTP server (127.0.0.1:7777)',
    detail: httpReachableNow ? 'responding' : 'not reachable',
    hint: httpReachableNow
      ? undefined
      : "Probably fine if engram-mcp runs in stdio-only mode (Claude Code, '--no-http' arg).",
  });

  // Embedding backend
  section('Embedding backend');
  if (provider === 'ollama') {
    const baseUrl = embeddings.baseUrl ?? 'http://localhost:11434';
    const reachable = await httpReachable(`${baseUrl}/api/tags`);
    if (!reachable) {
      row({
        ok: 'fail',
        label: `Ollama @ ${baseUrl}`,
        detail: 'not reachable',
        hint: 'Start Ollama: `ollama serve` or `brew services start ollama`.',
      });
    } else {
      row({ ok: 'pass', label: `Ollama @ ${baseUrl}`, detail: 'reachable' });
      const models = await ollamaListModels(baseUrl);
      if (!models) {
        row({ ok: 'warn', label: `Ollama model "${model}"`, detail: 'could not list models' });
      } else {
        // Ollama returns model:tag entries — match by prefix.
        const found = models.some((m) => m === model || m.startsWith(`${model}:`));
        row({
          ok: found ? 'pass' : 'fail',
          label: `Ollama model "${model}"`,
          detail: found ? 'pulled' : 'not pulled',
          hint: found ? undefined : `ollama pull ${model}`,
        });
      }
    }
  } else if (provider === 'voyage' || provider === 'openai') {
    const envKey = provider === 'voyage' ? 'VOYAGE_API_KEY' : 'OPENAI_API_KEY';
    const hasKey =
      (process.env[envKey] && process.env[envKey].length > 5) ||
      ('apiKey' in embeddings && (embeddings as { apiKey?: string }).apiKey);
    row({
      ok: hasKey ? 'pass' : 'fail',
      label: `${provider} API key`,
      detail: hasKey ? 'present' : 'missing',
      hint: hasKey ? undefined : `Set ${envKey} or add embeddings.apiKey to ${CONFIG_PATH}.`,
    });
  } else if (provider === 'engram' || provider === 'engram-hosted') {
    row({
      ok: 'info' as 'warn',
      label: 'engram-hosted embeddings',
      detail: 'Pro tier — health check not implemented yet',
    });
  }

  // Vector store
  section('Vector store');
  const vm = await inspectVectorStore();
  if (!vm) {
    row({
      ok: 'warn',
      label: 'LanceDB tables',
      detail: 'no tables yet (or vectors dir missing)',
      hint: 'Will be populated on first remember(). For an existing install: `engram-mcp rebuild`.',
    });
  } else if (vm.tables.length === 0) {
    row({ ok: 'warn', label: 'LanceDB tables', detail: '0 tables — empty store' });
  } else {
    row({
      ok: 'pass',
      label: 'LanceDB tables',
      detail: `${vm.tables.length} table(s)`,
    });
    if (vm.firstTableDim !== null) {
      const dimOk = vm.firstTableDim === dimensions;
      row({
        ok: dimOk ? 'pass' : 'fail',
        label: 'vector dim',
        detail: dimOk
          ? `${vm.firstTableDim}-d (matches config)`
          : `tables=${vm.firstTableDim}-d, config=${dimensions}-d`,
        hint: dimOk
          ? undefined
          : 'Likely you changed the embedding model without rebuilding. Run `engram-mcp-setup-embeddings` (drop vectors) then `engram-mcp rebuild`.',
      });
    }
  }

  console.log('');
}

main().catch((e) => {
  console.error(C.fail, e instanceof Error ? e.message : e);
  process.exit(1);
});
