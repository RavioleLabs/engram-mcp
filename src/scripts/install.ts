#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline/promises';
import { spawnSync, spawn } from 'child_process';
import { defaultConfig, type EngramConfig } from '../config/schema.js';
import { installOllama, isOllamaInstalled } from './install-ollama.js';

const ENGRAM_DIR = path.join(os.homedir(), '.engram');
const CONFIG_PATH = path.join(ENGRAM_DIR, 'config.json');

async function main() {
  console.log('\n  EngramMCP — local-first semantic memory for AI agents\n');

  fs.mkdirSync(ENGRAM_DIR, { recursive: true, mode: 0o700 });

  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`✓ Existing config found at ${CONFIG_PATH}`);
  } else {
    console.log(`Creating config at ${CONFIG_PATH}…`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // 1. Is Ollama installed AND running?
  let ollamaUp = await checkOllamaRunning();
  if (!ollamaUp) {
    const ollamaBinaryPresent = isOllamaInstalled();
    if (!ollamaBinaryPresent) {
      console.log('\nOllama is not installed on this machine.');
      console.log(
        'EngramMCP uses Ollama by default to run embeddings 100% locally (free, private).',
      );
      console.log(
        'Alternative: use Engram-hosted embeddings (Pro, requires API key, no local install).\n',
      );

      const choice = (
        await rl.question('? [I]nstall Ollama now / [E]ngram hosted / [s]kip and exit: ')
      )
        .trim()
        .toLowerCase();

      if (choice === 'i' || choice === 'install' || choice === '') {
        await installOllama();
        ollamaUp = await checkOllamaRunning();
        if (!ollamaUp) {
          console.log('✗ Ollama installed but not running. Start it with: ollama serve');
          rl.close();
          process.exit(1);
        }
      } else if (choice === 'e' || choice === 'engram') {
        await setupEngramHostedProvider(rl);
        rl.close();
        printMcpSnippet();
        return;
      } else {
        console.log('Exiting. Install Ollama from https://ollama.com/download then re-run.');
        rl.close();
        process.exit(0);
      }
    } else {
      console.log('Ollama is installed but not running. Starting it…');
      const proc = spawn('ollama', ['serve'], { stdio: 'ignore', detached: true });
      proc.unref();
      // Wait briefly for boot
      await new Promise((r) => setTimeout(r, 2000));
      ollamaUp = await checkOllamaRunning();
      if (!ollamaUp) {
        console.log('✗ Could not auto-start Ollama. Start it with: ollama serve');
        rl.close();
        process.exit(1);
      }
    }
  }
  console.log('✓ Ollama is running');

  // 2. Pull models
  const wantPull = (await rl.question('? Pull nomic-embed-text embedding model (~270MB)? [Y/n] '))
    .trim()
    .toLowerCase();
  if (wantPull === '' || wantPull === 'y' || wantPull === 'yes') {
    runOllama(['pull', 'nomic-embed-text']);
    console.log('✓ Embedding model ready');
  }

  // Optional: pull a small LLM for opt-in auto property extraction.
  // Off by default — the calling agent provides title/tags, and the new
  // `suggest_properties` MCP tool lets the agent enrich existing memories.
  const wantSmall = (
    await rl.question(
      '? Pull llama3.2:3b for OPT-IN background property extraction (~2GB, skip unless you know you want it)? [y/N] ',
    )
  )
    .trim()
    .toLowerCase();
  if (wantSmall === 'y' || wantSmall === 'yes') {
    runOllama(['pull', 'llama3.2:3b']);
    console.log(
      '✓ Property-extraction model ready (set propertyExtraction.enabled=true in config to use)',
    );
  }

  // 3. Whisper provider choice
  console.log('\nAudio transcription (Whisper) provider:');
  console.log('  [1] Local whisper.cpp (free, requires ~500MB model download on first use)');
  console.log('  [2] Engram cloud whisper (Pro $9/mo, includes 5h/month, no local install)');
  const whisperChoice = (await rl.question('? Choose whisper provider [1]: ')).trim();

  let whisperProvider: 'local' | 'engram-hosted' = 'local';
  if (whisperChoice === '2') {
    whisperProvider = 'engram-hosted';
    console.log('  Engram-hosted whisper selected — requires engramAccount.apiKey in config.');
    console.log('  Get your API key at https://engram-mcp.com/settings after pairing.');
  } else {
    console.log('  Local whisper.cpp selected (default).');
  }

  // 4. Write config if missing
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg: EngramConfig = {
      ...defaultConfig,
      whisper: {
        ...defaultConfig.whisper,
        provider: whisperProvider,
      },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    fs.chmodSync(CONFIG_PATH, 0o600);
    console.log(`✓ Wrote default config to ${CONFIG_PATH}`);
  } else if (whisperProvider === 'engram-hosted') {
    // Patch existing config whisper provider without overwriting other fields
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as EngramConfig;
    existing.whisper = { ...existing.whisper, provider: 'engram-hosted' };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2));
    fs.chmodSync(CONFIG_PATH, 0o600);
    console.log('✓ Updated config: whisper.provider = engram-hosted');
  }

  printMcpSnippet();
  rl.close();
}

function printMcpSnippet(): void {
  console.log('\n┄ Next: add EngramMCP to your agent runtime ─────────────────────');
  console.log('\nClaude Code — add to ~/.claude/mcp.json:\n');
  console.log(
    JSON.stringify(
      { mcpServers: { engram: { command: 'engram-mcp', args: ['--no-http'] } } },
      null,
      2,
    ),
  );
  console.log('\nCursor — add to ~/.cursor/mcp.json (same shape).');
  console.log('\n  --no-http is recommended: runs the MCP server only, no local web UI.');
  console.log('  The official dashboard is https://engram-mcp.com — sign up to view your');
  console.log('  memories from anywhere without a local server running.\n');
  console.log('Start the server with:  engram-mcp --no-http');
  console.log('Official dashboard:     https://engram-mcp.com');
  console.log('Local dev UI (opt-in):  engram-mcp  (without --no-http) → http://localhost:7777');
  console.log('Run reindex (after model swap): npm run reindex');
}

async function setupEngramHostedProvider(rl: ReturnType<typeof createInterface>): Promise<void> {
  console.log('\nEngram hosted embeddings + whisper — Pro tier ($9/mo).');
  console.log('Includes 10M embedding tokens + 5h whisper audio per month.');
  console.log('Get your API key at https://engram-mcp.com/settings.');
  const apiKey = (
    await rl.question('? Paste your Engram API key (or leave blank to use placeholder): ')
  ).trim();

  const wantHostedWhisper = (await rl.question('? Also use Engram-hosted whisper? [Y/n] '))
    .trim()
    .toLowerCase();
  const useHostedWhisper =
    wantHostedWhisper === '' || wantHostedWhisper === 'y' || wantHostedWhisper === 'yes';

  const cfg = {
    ...defaultConfig,
    embeddings: {
      provider: 'engram-hosted' as const,
      model: 'engram-base',
      apiKey: apiKey || 'PASTE_YOUR_ENGRAM_API_KEY_HERE',
      dimensions: 768,
    },
    whisper: {
      ...defaultConfig.whisper,
      provider: useHostedWhisper ? ('engram-hosted' as const) : ('local' as const),
    },
    // Disable local property extraction since we're not pulling local LLMs
    propertyExtraction: {
      ...defaultConfig.propertyExtraction,
      enabled: false,
    },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log(`✓ Wrote config (Engram hosted) to ${CONFIG_PATH}`);
  if (!apiKey) {
    console.log(
      '  Edit the file and replace PASTE_YOUR_ENGRAM_API_KEY_HERE with your real key before starting.',
    );
  }
}

async function checkOllamaRunning(): Promise<boolean> {
  try {
    const r = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function runOllama(args: string[]): void {
  const r = spawnSync('ollama', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ ollama ${args.join(' ')} failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
