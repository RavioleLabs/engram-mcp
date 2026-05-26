// src/mcp-server/tests/mcp-e2e.test.ts
// E2E tests against the full 21-tool public surface.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('MCP E2E (real subprocess) — full 24-tool public surface', () => {
  let tmpDir: string;
  let client: Client;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-e2e-'));

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/scripts/serve.ts', '--no-http'],
      env: { ...process.env, ENGRAM_CONFIG_DIR: tmpDir, DATA_DIR: tmpDir },
      cwd: process.cwd(),
    });

    client = new Client({ name: 'engram-e2e-test', version: '0.0.0' }, { capabilities: {} });

    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists expected public tools (all tools always available)', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    // Core memory tools
    expect(names).toContain('remember');
    expect(names).toContain('recall');
    expect(names).toContain('get');
    expect(names).toContain('update');
    expect(names).toContain('forget');
    expect(names).toContain('relate');
    expect(names).toContain('list_types');
    expect(names).toContain('describe_types');
    expect(names).toContain('recent');
    expect(names).toContain('ingest');
    expect(names).toContain('suggest_properties');
    expect(names).toContain('get_ingest_status');
    // Watch/source tools
    expect(names).toContain('watch');
    expect(names).toContain('unwatch');
    expect(names).toContain('list_sources');
    // Type tools
    expect(names).toContain('create_type');
    expect(names).toContain('delete_type');
    // Previously-admin tools — now always public
    expect(names).toContain('connect_drive');
    expect(names).toContain('list_drive_files');
    expect(names).toContain('connect_notion');
    expect(names).toContain('list_notion_pages');
    expect(names).toContain('import_watch_later');
    // Cross-memory inference tools
    expect(names).toContain('analyze_patterns');
    expect(names).toContain('summarize_recent');
    expect(names).toContain('find_gaps');

    // Old per-module tools must NOT be present
    expect(names).not.toContain('add_note');
    expect(names).not.toContain('search_notes');
    expect(names).not.toContain('search_all');
    expect(names).not.toContain('get_memory');
    expect(names).not.toContain('remember_exchange');
    expect(names).not.toContain('search_conversations');
    expect(names).not.toContain('find_related');
    expect(names).not.toContain('delete_memory');
    expect(names).not.toContain('set_properties');
    expect(names).not.toContain('add_audio_file');
    expect(names).not.toContain('add_youtube_url');
    expect(names).not.toContain('create_custom_type');

    // Total should be exactly 24 (+ custom types loaded at boot, which is 0 for fresh tmpDir)
    expect(names.length).toBe(24);
  });

  it('remember then recall finds the memory', async () => {
    const remRes = await client.callTool({
      name: 'remember',
      arguments: {
        content: 'ULIDs are temporally ordered and sortable, unlike UUIDs which are random.',
        title: 'ULID vs UUID comparison',
        tags: ['ulid', 'uuid', 'identifiers'],
        type: 'notes',
      },
    });
    expect(remRes.isError).toBeFalsy();
    const remPayload = JSON.parse((remRes.content as Array<{ text: string }>)[0].text) as {
      id: string;
      wikilinks_extracted: string[];
    };
    expect(remPayload.id).toBeTruthy();

    const recallRes = await client.callTool({
      name: 'recall',
      arguments: { query: 'sortable identifiers', limit: 5 },
    });
    const recallPayload = JSON.parse(
      (recallRes.content as Array<{ text: string }>)[0].text,
    ) as Array<{ id: string; score: number }>;
    expect(recallPayload.length).toBeGreaterThan(0);
    expect(recallPayload[0].score).toBeGreaterThan(0.3);
  }, 30_000);

  it('remember then get retrieves full memory', async () => {
    const remRes = await client.callTool({
      name: 'remember',
      arguments: {
        content: 'Polymarket pricing strategy for sports markets uses Kelly criterion.',
        title: 'Polymarket sports strategy',
        tags: ['polymarket', 'sports', 'kelly'],
      },
    });
    expect(remRes.isError).toBeFalsy();
    const { id } = JSON.parse((remRes.content as Array<{ text: string }>)[0].text) as {
      id: string;
    };

    const getRes = await client.callTool({ name: 'get', arguments: { id } });
    expect(getRes.isError).toBeFalsy();
    const getPayload = JSON.parse((getRes.content as Array<{ text: string }>)[0].text) as {
      id: string;
      content: string;
      properties: { title: string };
    };
    expect(getPayload.id).toBe(id);
    expect(getPayload.content).toContain('Kelly');
    expect(getPayload.properties.title).toBe('Polymarket sports strategy');
  }, 20_000);

  it('update mutates properties on an existing memory', async () => {
    const remRes = await client.callTool({
      name: 'remember',
      arguments: { content: 'Meeting notes from standup, no title yet.' },
    });
    const { id } = JSON.parse((remRes.content as Array<{ text: string }>)[0].text) as {
      id: string;
    };

    const updRes = await client.callTool({
      name: 'update',
      arguments: { id, title: 'Standup May 19', tags: ['standup', 'meeting'] },
    });
    expect(updRes.isError).toBeFalsy();
    const updPayload = JSON.parse((updRes.content as Array<{ text: string }>)[0].text) as {
      updated: boolean;
    };
    expect(updPayload.updated).toBe(true);

    const getRes = await client.callTool({ name: 'get', arguments: { id } });
    const getPayload = JSON.parse((getRes.content as Array<{ text: string }>)[0].text) as {
      properties: { title: string; tags: string[] };
    };
    expect(getPayload.properties.title).toBe('Standup May 19');
    expect(getPayload.properties.tags).toContain('standup');
  }, 20_000);

  it('forget removes the memory', async () => {
    const remRes = await client.callTool({
      name: 'remember',
      arguments: { content: 'Temporary test memory — please delete.' },
    });
    const { id } = JSON.parse((remRes.content as Array<{ text: string }>)[0].text) as {
      id: string;
    };

    const forgetRes = await client.callTool({ name: 'forget', arguments: { id } });
    expect(forgetRes.isError).toBeFalsy();

    const getRes = await client.callTool({ name: 'get', arguments: { id } });
    const getPayload = JSON.parse((getRes.content as Array<{ text: string }>)[0].text) as {
      error?: string;
    };
    expect(getPayload.error).toBe('not_found');
  }, 20_000);

  it('ingest routes a .md file and returns id', async () => {
    const mdPath = path.join(tmpDir, `test-${Date.now()}.md`);
    fs.writeFileSync(mdPath, '# Ingest Test\n\nThis note was ingested via the ingest tool.');

    const ingestRes = await client.callTool({
      name: 'ingest',
      arguments: { uri: mdPath, tags: ['ingest-test'] },
    });
    expect(ingestRes.isError).toBeFalsy();
    const payload = JSON.parse((ingestRes.content as Array<{ text: string }>)[0].text) as {
      id: string;
      type: string;
    };
    expect(payload.id).toBeTruthy();
    expect(payload.type).toBe('notes');
  }, 20_000);
});
