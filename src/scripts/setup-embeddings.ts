#!/usr/bin/env node
// Interactive setup wizard for the embedding model / provider.
//
// Background: `nomic-embed-text` (768-d, Ollama) is the default — works
// everywhere but is mediocre on FR. The stress test (specs/2026-05-27)
// identified the embedding model as the root cause behind §R2 (FR
// "comment X" queries miss). This wizard lets the user pick a different
// provider/model + writes ~/.engram/config.json + offers to drop the
// vector tables so the next reindex rebuilds at the new dimension.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline/promises';
import { spawn } from 'child_process';
import { defaultConfig, type EngramConfig, type EmbeddingsConfig } from '../config/schema.js';

const ENGRAM_DIR = path.join(os.homedir(), '.engram');
const CONFIG_PATH = path.join(ENGRAM_DIR, 'config.json');
const VECTORS_DIR = path.join(ENGRAM_DIR, 'vectors');

interface Preset {
  label: string;
  provider: EmbeddingsConfig['provider'];
  model: string;
  dimensions: number;
  notes: string;
  needsApiKey: boolean;
  ollamaPull?: string;
}

const PRESETS: Preset[] = [
  {
    label: 'nomic-embed-text (default)',
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimensions: 768,
    notes: 'Free, local. EN strong, FR moderate. Original default.',
    needsApiKey: false,
    ollamaPull: 'nomic-embed-text',
  },
  {
    label: 'bge-m3 — multilingual',
    provider: 'ollama',
    model: 'bge-m3',
    dimensions: 1024,
    notes: 'Free, local. Recommended for FR / multilingual content.',
    needsApiKey: false,
    ollamaPull: 'bge-m3',
  },
  {
    label: 'mxbai-embed-large',
    provider: 'ollama',
    model: 'mxbai-embed-large',
    dimensions: 1024,
    notes: 'Free, local. Strong on EN technical content.',
    needsApiKey: false,
    ollamaPull: 'mxbai-embed-large',
  },
  {
    label: 'snowflake-arctic-embed:l',
    provider: 'ollama',
    model: 'snowflake-arctic-embed:l',
    dimensions: 1024,
    notes: 'Free, local. MTEB top tier on retrieval benchmarks.',
    needsApiKey: false,
    ollamaPull: 'snowflake-arctic-embed:l',
  },
  {
    label: 'voyage-3 — Voyage AI API',
    provider: 'voyage',
    model: 'voyage-3',
    dimensions: 1024,
    notes: 'Paid API. Top-tier multilingual. Requires VOYAGE_API_KEY.',
    needsApiKey: true,
  },
  {
    label: 'text-embedding-3-small — OpenAI',
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    notes: 'Paid API. Cheap, strong. Requires OPENAI_API_KEY.',
    needsApiKey: true,
  },
  {
    label: 'text-embedding-3-large — OpenAI',
    provider: 'openai',
    model: 'text-embedding-3-large',
    dimensions: 3072,
    notes: 'Paid API. Highest quality, 3072-d. Requires OPENAI_API_KEY.',
    needsApiKey: true,
  },
];

async function main(): Promise<void> {
  console.log('\n  EngramMCP — Embedding model setup\n');

  if (!fs.existsSync(ENGRAM_DIR)) {
    fs.mkdirSync(ENGRAM_DIR, { recursive: true, mode: 0o700 });
  }

  let cfg: EngramConfig;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as EngramConfig;
    } catch (e) {
      console.error(`✗ Could not parse ${CONFIG_PATH}: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  } else {
    cfg = { ...defaultConfig };
  }

  const cur = cfg.embeddings ?? defaultConfig.embeddings;
  console.log(
    `Current: provider=${cur.provider}, model=${cur.model}, dimensions=${cur.dimensions ?? 768}\n`,
  );

  console.log('Choose an embedding model:\n');
  PRESETS.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.label}`);
    console.log(`     dim=${p.dimensions}  |  ${p.notes}`);
  });
  console.log(`  ${PRESETS.length + 1}. Custom (advanced — provider, model, dim by hand)`);
  console.log(`  0. Cancel\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choice = (await rl.question('? Choice [1]: ')).trim() || '1';
  const n = parseInt(choice, 10);

  if (n === 0 || Number.isNaN(n)) {
    console.log('Aborted — no changes made.');
    rl.close();
    process.exit(0);
  }

  let newCfg: EmbeddingsConfig;
  if (n === PRESETS.length + 1) {
    const provider = (await rl.question('? Provider (ollama/voyage/openai/openai-compatible): '))
      .trim()
      .toLowerCase();
    const model = (await rl.question('? Model name: ')).trim();
    const dimStr = (await rl.question('? Dimensions (integer): ')).trim();
    const dimensions = parseInt(dimStr, 10);
    if (!provider || !model || !Number.isFinite(dimensions) || dimensions <= 0) {
      console.error('✗ Invalid input. Aborted.');
      rl.close();
      process.exit(1);
    }
    newCfg = {
      ...cur,
      provider: provider as EmbeddingsConfig['provider'],
      model,
      dimensions,
    };
  } else if (n >= 1 && n <= PRESETS.length) {
    const p = PRESETS[n - 1];
    newCfg = {
      ...cur,
      provider: p.provider,
      model: p.model,
      dimensions: p.dimensions,
    };
    if (p.needsApiKey) {
      const env =
        p.provider === 'voyage'
          ? 'VOYAGE_API_KEY'
          : p.provider === 'openai'
          ? 'OPENAI_API_KEY'
          : null;
      if (env && !process.env[env] && !cur.apiKey) {
        const k = (
          await rl.question(`? Paste your API key (or leave blank to set ${env} later): `)
        ).trim();
        if (k) newCfg.apiKey = k;
      }
    }
    if (p.ollamaPull) {
      console.log(`\n  → Will require: \`ollama pull ${p.ollamaPull}\` (run after this wizard).`);
    }
  } else {
    console.error('✗ Invalid choice.');
    rl.close();
    process.exit(1);
  }

  // Detect if dim changed → we need to drop the vector tables.
  const oldDim = cur.dimensions ?? 768;
  const dimChanged = newCfg.dimensions !== oldDim;

  cfg.embeddings = newCfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);

  console.log(`\n✓ Saved to ${CONFIG_PATH}:`);
  console.log(
    `  provider=${newCfg.provider}, model=${newCfg.model}, dimensions=${newCfg.dimensions}`,
  );

  if (!dimChanged && cur.provider === newCfg.provider && cur.model === newCfg.model) {
    console.log(
      '\n(No change to provider/model/dim — restart engram-mcp to pick up other fields.)',
    );
    rl.close();
    return;
  }

  if (dimChanged) {
    console.log(
      `\n⚠  Dimension changed (${oldDim} → ${newCfg.dimensions}). Existing vector tables ` +
        `are incompatible — they must be dropped and rebuilt.`,
    );
  } else {
    console.log(
      `\nProvider/model changed but dimension is the same. You can reindex in place ` +
        `(no drop needed) — but content already embedded with the old model will be ` +
        `compared against new-model query vectors, which usually hurts recall.`,
    );
  }

  const drop = (await rl.question('? Drop vector tables now so reindex rebuilds them? [Y/n] '))
    .trim()
    .toLowerCase();
  rl.close();

  if (drop === '' || drop === 'y' || drop === 'yes') {
    if (fs.existsSync(VECTORS_DIR)) {
      fs.rmSync(VECTORS_DIR, { recursive: true, force: true });
      console.log(`✓ Removed ${VECTORS_DIR}`);
    }
    console.log('\nNext steps:');
    console.log('  1. Restart engram-mcp (LaunchAgent/systemd will respawn it).');
    console.log('  2. Run `engram-mcp rebuild` to re-embed all existing memories at the new dim.');
    console.log('     (Or it will rebuild lazily as new content arrives.)');
  } else {
    console.log('\nKept tables. To migrate later: rm -rf ~/.engram/vectors && engram-mcp rebuild');
  }

  if (dimChanged) {
    const restart = await new Promise<boolean>((resolve) => {
      const r = createInterface({ input: process.stdin, output: process.stdout });
      r.question('? Restart engram-mcp now via LaunchAgent? [Y/n] ').then((ans) => {
        r.close();
        resolve(ans.trim() === '' || ans.trim().toLowerCase().startsWith('y'));
      });
    });
    if (restart && process.platform === 'darwin') {
      tryRestartLaunchAgent();
    }
  }
}

function tryRestartLaunchAgent(): void {
  // Best effort — typo'd plist label "com.ravolelabs.engram" remains in the
  // install.sh script as of v0.6.3. Try both.
  for (const label of ['com.raviolelabs.engram-mcp', 'com.ravolelabs.engram']) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (fs.existsSync(plist)) {
      spawn('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${label}`], {
        stdio: 'ignore',
      });
      console.log(`✓ Asked launchd to restart ${label}.`);
      return;
    }
  }
  console.log('(No matching LaunchAgent found — restart engram-mcp manually.)');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
