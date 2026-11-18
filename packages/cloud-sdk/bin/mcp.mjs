#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { endpointURL } from '../src/index.mjs';

try {
  const endpoint = endpointURL(process.env.ENGRAM_ENDPOINT);
  const key = (
    process.env.ENGRAM_KEY_FILE
      ? await readFile(process.env.ENGRAM_KEY_FILE, 'utf8')
      : process.env.ENGRAM_KEY || ''
  ).trim();
  if (!/^egc_[A-Za-z0-9_-]{43}$/.test(key)) throw Error('missing_key');
  const remote = new Client({ name: 'Engram Cloud bridge', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint + '/mcp'), {
    requestInit: { headers: { authorization: 'Bearer ' + key }, redirect: 'error' },
  });
  await remote.connect(transport);
  const server = new Server(
    { name: 'engram-cloud', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => remote.listTools());
  server.setRequestHandler(CallToolRequestSchema, (request) => remote.callTool(request.params));
  await server.connect(new StdioServerTransport());
  const stop = async () => {
    await remote.close();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
} catch {
  // MCP stdout is reserved for the protocol; do not expose upstream errors or credentials.
  process.stderr.write(
    'Engram Cloud could not connect. Check ENGRAM_ENDPOINT, ENGRAM_KEY_FILE and the key’s expiry.\n',
  );
  process.exitCode = 1;
}
