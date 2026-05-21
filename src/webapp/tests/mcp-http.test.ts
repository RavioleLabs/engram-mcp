import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { ToolRouter } from '../../mcp-server/tool-router.js';
import { mountMcpHttp } from '../mcp-http.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

describe('HTTP MCP transport', () => {
  let server: http.Server;
  let baseUrl: string;
  let client: Client;

  beforeAll(async () => {
    const router = new ToolRouter();
    router.register({
      name: 'echo',
      description: 'echo back',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async (args) => ({ echoed: args.text }),
    });

    const app = express();
    mountMcpHttp(app, router);
    server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://localhost:${port}`;

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    client = new Client(
      { name: 'mcp-http-test', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
  }, 15_000);

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists tools', async () => {
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name)).toContain('echo');
  });

  it('calls a tool', async () => {
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.echoed).toBe('hi');
  });
});
