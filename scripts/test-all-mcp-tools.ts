#!/usr/bin/env npx tsx
/**
 * scripts/test-all-mcp-tools.ts
 *
 * Standalone smoke test that:
 *  1. Spawns engram-mcp via MCP stdio client (isolated temp data dir)
 *  2. Enumerates every tool via listTools()
 *  3. Calls each tool with realistic arguments in dependency order
 *  4. Prints a summary table: tool | status | reason
 *  5. Exits 0 if all called tools pass, 1 if any failed
 *
 * Usage:
 *   npx tsx scripts/test-all-mcp-tools.ts
 *
 * Requirements:
 *  - Ollama running locally on :11434 with nomic-embed-text pulled
 *    (or set ENGRAM_EMBEDDINGS_PROVIDER=openai + OPENAI_API_KEY)
 *  - yt-dlp installed (brew install yt-dlp) for add_youtube_url test
 *  - nodejs-whisper model downloaded (happens automatically first run; ~100MB for tiny.en)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIO_FIXTURE = path.join(
  REPO_ROOT,
  'src/memory/modules/audio/tests/fixtures/hello.wav',
);

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
type Status = 'OK' | 'FAIL' | 'SKIP';
interface Result {
  tool: string;
  status: Status;
  reason: string;
  durationMs?: number;
}
const results: Result[] = [];

function record(tool: string, status: Status, reason: string, durationMs?: number) {
  results.push({ tool, status, reason, durationMs });
}

// ---------------------------------------------------------------------------
// Helper: call a tool and return the parsed JSON payload
// ---------------------------------------------------------------------------
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    const msg =
      (res.content as Array<{ text: string }>)[0]?.text ?? 'unknown error';
    throw new Error(msg);
  }
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // --- Setup temp dir ---------------------------------------------------------
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-smoke-'));
  const tmpVault = path.join(tmpDir, 'test-vault');
  fs.mkdirSync(tmpVault, { recursive: true });
  // Create two markdown files for Obsidian test
  fs.writeFileSync(
    path.join(tmpVault, 'Note1.md'),
    '# Alpha Note\nThis is about machine learning and neural networks.',
  );
  fs.writeFileSync(
    path.join(tmpVault, 'Note2.md'),
    '# Beta Note\nThis is about cooking recipes and pancakes.',
  );

  console.log(`[smoke] temp dir: ${tmpDir}`);
  console.log('[smoke] connecting to engram-mcp...');

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/scripts/serve.ts', '--no-http'],
    env: {
      ...process.env,
      ENGRAM_CONFIG_DIR: tmpDir,
      DATA_DIR: tmpDir,
      // Use a whisper model that's fast to load for the smoke test
    },
    cwd: REPO_ROOT,
  });

  const client = new Client(
    { name: 'engram-smoke', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log('[smoke] connected.\n');
  } catch (e) {
    console.error('[smoke] FATAL: could not connect to MCP server:', e);
    process.exit(1);
  }

  // --- Enumerate tools --------------------------------------------------------
  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((t) => t.name));
  console.log(`[smoke] ${toolNames.size} tools registered:\n  ${[...toolNames].join(', ')}\n`);

  // These tools require OAuth flows that cannot be automated
  const OAUTH_SKIP = new Set([
    'connect_drive',
    'connect_notion',
    'connect_youtube_account', // not in current tool list but guard anyway
  ]);

  // Track IDs we collect during the run for later tools
  let noteId: string | undefined;
  let convId: string | undefined;
  let audioId: string | undefined;
  let youtubeId: string | undefined;
  let obsidianId: string | undefined;
  let recipeId: string | undefined;
  let allFirstId: string | undefined;

  // ---------------------------------------------------------------------------
  // TOOL TESTS — executed in dependency order
  // ---------------------------------------------------------------------------

  // skip OAuth tools up front
  for (const name of OAUTH_SKIP) {
    if (toolNames.has(name)) {
      record(name, 'SKIP', 'OAuth required — manual smoke needed');
    }
  }

  // 1. add_note ----------------------------------------------------------------
  {
    const t = 'add_note';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {
          content:
            'Test note about semantic search and vector embeddings in LanceDB.',
          title: 'Vector Search Test',
          tags: ['test', 'vector', 'lancedb'],
        }) as { id?: string };
        noteId = res.id;
        record(t, 'OK', `id=${noteId}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 2. search_notes ------------------------------------------------------------
  {
    const t = 'search_notes';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { query: 'vector embeddings', limit: 5 }) as Array<unknown>;
        if (!Array.isArray(res) || res.length === 0) throw new Error('empty results');
        record(t, 'OK', `${res.length} hits`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 3. remember_exchange -------------------------------------------------------
  {
    const t = 'remember_exchange';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {
          user_message: 'hi there',
          assistant_message: 'hello, how can I help?',
          agent: 'test-agent',
          title: 'greeting',
          tags: ['greeting', 'test'],
        }) as { id?: string };
        convId = res.id;
        record(t, 'OK', `id=${convId}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 4. search_conversations ----------------------------------------------------
  {
    const t = 'search_conversations';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { query: 'greeting hello', limit: 5 }) as Array<unknown>;
        if (!Array.isArray(res) || res.length === 0) throw new Error('empty results');
        record(t, 'OK', `${res.length} hits`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 5. add_obsidian_vault ------------------------------------------------------
  {
    const t = 'add_obsidian_vault';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {
          vault_path: tmpVault,
          title: 'Smoke Test Vault',
          tags: ['test', 'obsidian'],
        }) as { ids?: string[]; id?: string };
        obsidianId = res.ids?.[0] ?? res.id;
        record(t, 'OK', `ingested vault → id=${obsidianId}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 6. search_obsidian ---------------------------------------------------------
  {
    const t = 'search_obsidian';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { query: 'neural networks machine learning', limit: 5 }) as Array<unknown>;
        if (!Array.isArray(res) || res.length === 0) throw new Error('empty results');
        record(t, 'OK', `${res.length} hits`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 7. watch_obsidian_vault / unwatch_obsidian_vault ---------------------------
  for (const t of ['watch_obsidian_vault', 'unwatch_obsidian_vault'] as const) {
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); continue; }
    const start = Date.now();
    try {
      const args = t === 'watch_obsidian_vault'
        ? { vault_path: tmpVault }
        : { vault_path: tmpVault };
      await call(client, t, args);
      record(t, 'OK', '', Date.now() - start);
    } catch (e) {
      record(t, 'FAIL', String(e), Date.now() - start);
    }
  }

  // 8. add_audio_file ----------------------------------------------------------
  {
    const t = 'add_audio_file';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!fs.existsSync(AUDIO_FIXTURE)) {
      record(t, 'SKIP', `fixture not found: ${AUDIO_FIXTURE}`);
    } else {
      const start = Date.now();
      try {
        const res = await call(client, t, {
          path: AUDIO_FIXTURE,
          title: 'Hello Fixture',
          tags: ['test', 'audio'],
        }) as { id?: string };
        audioId = res.id;
        record(t, 'OK', `id=${audioId}`, Date.now() - start);
      } catch (e) {
        const msg = String(e);
        // Whisper model download failures are a local machine issue, not a code bug.
        // They occur when: (a) wget/curl dylib is broken, (b) no internet, (c) first run on fresh machine.
        if (msg.includes('Failed to download model') || msg.includes('dylib') || msg.includes('wget')) {
          record(t, 'SKIP', 'Whisper model not downloaded — run `npx nodejs-whisper download` or fix wget install', Date.now() - start);
        } else {
          record(t, 'FAIL', msg, Date.now() - start);
        }
      }
    }
  }

  // 9. search_audio ------------------------------------------------------------
  {
    const t = 'search_audio';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!audioId) { record(t, 'SKIP', 'add_audio_file did not produce an id'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { query: 'hello', limit: 5 }) as Array<unknown>;
        // Audio search may return 0 results if transcription is empty for the fixture
        record(t, 'OK', `${Array.isArray(res) ? res.length : '?'} hits`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 10. add_youtube_url --------------------------------------------------------
  {
    const t = 'add_youtube_url';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        // TED Talk — stable, long-standing, has English captions
        const res = await call(client, t, {
          url: 'https://www.youtube.com/watch?v=iG9CE55wbtY',
          title: 'Sir Ken Robinson — Do schools kill creativity?',
          tags: ['ted', 'education', 'test'],
        }) as { id?: string };
        youtubeId = res.id;
        record(t, 'OK', `id=${youtubeId}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 11. search_youtube ---------------------------------------------------------
  {
    const t = 'search_youtube';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!youtubeId) { record(t, 'SKIP', 'add_youtube_url did not produce an id'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { query: 'creativity schools education', limit: 5 }) as Array<unknown>;
        if (!Array.isArray(res) || res.length === 0) throw new Error('empty results');
        record(t, 'OK', `${res.length} hits`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 12. watch_youtube_channel / unwatch_youtube_channel -----------------------
  // channelId arg accepts a full channel URL (https://www.youtube.com/channel/UC...) or UC... ID directly
  {
    const t = 'watch_youtube_channel';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        await call(client, t, {
          channelId: 'UCAuUUnT6oDeKwE6v1NGQxug', // TED channel
          channelName: 'TED',
        });
        record(t, 'OK', '', Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }
  {
    const t = 'unwatch_youtube_channel';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      // check actual arg name for unwatch
      const start = Date.now();
      try {
        await call(client, t, { channelId: 'UCAuUUnT6oDeKwE6v1NGQxug' });
        record(t, 'OK', '', Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 13. import_watch_later -----------------------------------------------------
  {
    const t = 'import_watch_later';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      // Requires a real Watch Later playlist ID — skip with explanation
      record(t, 'SKIP', 'requires authenticated YouTube Watch Later playlist ID (manual smoke)');
    }
  }

  // 14. Drive tools (require OAuth) -------------------------------------------
  for (const t of ['list_drive_files', 'ingest_drive_file', 'watch_drive_file', 'unwatch_drive_file', 'search_drive']) {
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); continue; }
    record(t, 'SKIP', 'Drive OAuth required — run connect_drive first (manual smoke)');
  }

  // 15. Notion tools (require OAuth) ------------------------------------------
  for (const t of ['list_notion_pages', 'ingest_notion_page', 'watch_notion_page', 'unwatch_notion_page', 'search_notion']) {
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); continue; }
    record(t, 'SKIP', 'Notion OAuth required — run connect_notion first (manual smoke)');
  }

  // 16. create_custom_type -----------------------------------------------------
  {
    const t = 'create_custom_type';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        await call(client, t, {
          type_name: 'recipes',
          display_name: 'Recipes',
        });
        record(t, 'OK', 'created recipes type', Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 17. add_recipes (dynamic — created by create_custom_type) ------------------
  {
    const t = 'add_recipes';
    // Re-enumerate tools since create_custom_type registers new tools dynamically
    const { tools: tools2 } = await client.listTools();
    const toolNames2 = new Set(tools2.map((t) => t.name));
    if (!toolNames2.has(t)) { record(t, 'SKIP', 'dynamic tool not found after create_custom_type'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {
          content: 'Pancakes: 1 cup flour, 1 cup milk, 2 eggs, 2 tbsp sugar, 1 tsp baking powder. Mix and fry.',
          title: 'Classic Pancakes',
          tags: ['breakfast', 'easy', 'test'],
        }) as { id?: string };
        recipeId = res.id;
        record(t, 'OK', `id=${recipeId}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 18. search_recipes (dynamic) -----------------------------------------------
  {
    const t = 'search_recipes';
    const { tools: tools3 } = await client.listTools();
    const toolNames3 = new Set(tools3.map((t) => t.name));
    if (!toolNames3.has(t)) { record(t, 'SKIP', 'dynamic tool not found'); }
    else if (!recipeId) { record(t, 'SKIP', 'add_recipes did not produce an id'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { query: 'pancake batter breakfast', limit: 5 }) as Array<unknown>;
        if (!Array.isArray(res) || res.length === 0) throw new Error('empty results');
        record(t, 'OK', `${res.length} hits`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 19. list_custom_types ------------------------------------------------------
  {
    const t = 'list_custom_types';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {}) as { types?: string[] };
        record(t, 'OK', `types: ${JSON.stringify(res.types ?? res)}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 20. search_all -------------------------------------------------------------
  {
    const t = 'search_all';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { query: 'test', limit: 10 }) as Array<{ id: string }>;
        if (!Array.isArray(res) || res.length === 0) throw new Error('empty results');
        allFirstId = res[0].id;
        record(t, 'OK', `${res.length} hits across all types`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 21. list_types -------------------------------------------------------------
  {
    const t = 'list_types';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {}) as { types: string[] };
        if (!res.types || res.types.length === 0) throw new Error('no types returned');
        record(t, 'OK', `${res.types.join(', ')}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 22. get_memory -------------------------------------------------------------
  {
    const t = 'get_memory';
    const targetId = noteId ?? convId ?? allFirstId;
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!targetId) { record(t, 'SKIP', 'no memory id available'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { id: targetId }) as { id?: string };
        if (!res.id) throw new Error('no id in response');
        record(t, 'OK', `fetched id=${res.id}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 23. find_related -----------------------------------------------------------
  {
    const t = 'find_related';
    const targetId = noteId ?? convId ?? allFirstId;
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!targetId) { record(t, 'SKIP', 'no memory id available'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { id: targetId, limit: 5 }) as Array<unknown>;
        // May be empty if only one item of this type — that's OK
        record(t, 'OK', `${Array.isArray(res) ? res.length : '?'} related`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 24. suggest_properties -----------------------------------------------------
  {
    const t = 'suggest_properties';
    const targetId = noteId ?? convId ?? allFirstId;
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!targetId) { record(t, 'SKIP', 'no memory id available'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { id: targetId }) as { memory_id?: string; instruction?: string };
        if (!res.memory_id) throw new Error('no memory_id in response');
        record(t, 'OK', `got suggestion for id=${res.memory_id}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 25. set_properties ---------------------------------------------------------
  {
    const t = 'set_properties';
    const targetId = noteId ?? convId ?? allFirstId;
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!targetId) { record(t, 'SKIP', 'no memory id available'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {
          id: targetId,
          title: 'Smoke Test Renamed',
          tags: ['smoke', 'renamed'],
        }) as { updated?: boolean };
        if (!res.updated) throw new Error(`updated=false for id=${targetId}`);
        record(t, 'OK', `renamed id=${targetId}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 26. list_sources -----------------------------------------------------------
  {
    const t = 'list_sources';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, {});
        record(t, 'OK', `sources: ${JSON.stringify(res).slice(0, 80)}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 27. delete_custom_type -----------------------------------------------------
  {
    const t = 'delete_custom_type';
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else {
      const start = Date.now();
      try {
        await call(client, t, { type_name: 'recipes' });
        record(t, 'OK', 'deleted recipes type', Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // 28. delete_memory (last, cleanup) ------------------------------------------
  {
    const t = 'delete_memory';
    const targetId = noteId ?? convId ?? allFirstId;
    if (!toolNames.has(t)) { record(t, 'SKIP', 'not registered'); }
    else if (!targetId) { record(t, 'SKIP', 'no memory id available to delete'); }
    else {
      const start = Date.now();
      try {
        const res = await call(client, t, { id: targetId }) as { deleted?: string };
        if (!res.deleted) throw new Error('no deleted field in response');
        record(t, 'OK', `deleted id=${res.deleted}`, Date.now() - start);
      } catch (e) {
        record(t, 'FAIL', String(e), Date.now() - start);
      }
    }
  }

  // --- Check for any registered tools we didn't exercise --------------------
  {
    const { tools: finalTools } = await client.listTools();
    const exercised = new Set(results.map((r) => r.tool));
    for (const tool of finalTools) {
      if (!exercised.has(tool.name)) {
        record(tool.name, 'SKIP', 'not in smoke test script — add to scripts/test-all-mcp-tools.ts');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Disconnect + cleanup
  // ---------------------------------------------------------------------------
  await client.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ---------------------------------------------------------------------------
  // Print summary table
  // ---------------------------------------------------------------------------
  const COL1 = 38;
  const COL2 = 7;
  console.log('\n' + '─'.repeat(90));
  console.log(
    'TOOL'.padEnd(COL1) +
    'STATUS'.padEnd(COL2) +
    'DURATION'.padEnd(10) +
    'REASON',
  );
  console.log('─'.repeat(90));

  let passed = 0, failed = 0, skipped = 0;
  for (const r of results) {
    const colour = r.status === 'OK' ? GREEN : r.status === 'FAIL' ? RED : YELLOW;
    const dur = r.durationMs != null ? `${r.durationMs}ms` : '—';
    console.log(
      r.tool.padEnd(COL1) +
      `${colour}${r.status}${RESET}`.padEnd(COL2 + colour.length + RESET.length) +
      dur.padEnd(10) +
      r.reason,
    );
    if (r.status === 'OK') passed++;
    else if (r.status === 'FAIL') failed++;
    else skipped++;
  }
  console.log('─'.repeat(90));
  console.log(
    `\n${GREEN}${passed} OK${RESET}  ` +
    `${failed > 0 ? RED : ''}${failed} FAIL${RESET}  ` +
    `${YELLOW}${skipped} SKIP${RESET}\n`,
  );

  if (failed > 0) {
    console.error(`${RED}[smoke] ${failed} tool(s) failed. See above for details.${RESET}`);
    process.exit(1);
  } else {
    console.log(`${GREEN}[smoke] All called tools passed.${RESET}`);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('[smoke] Unhandled error:', e);
  process.exit(1);
});
