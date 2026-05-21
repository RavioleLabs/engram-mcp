import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import express from 'express';
import { createLogger } from '../logger.js';
import type { ToolRouter } from './tool-router.js';
import { ENGRAM_INSTRUCTIONS } from './instructions.js';

const log = createLogger('mcp-http');

function buildServer(router: ToolRouter): Server {
  const server = new Server(
    { name: 'engram-mcp', version: '0.2.0' },
    { capabilities: { tools: {} }, instructions: ENGRAM_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await router.call(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Tool ${name} failed: ${msg}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  });

  return server;
}

export function mountMcpHttp(app: Express, router: ToolRouter): void {
  app.use('/mcp', express.json({ limit: '4mb' }));
  app.post('/mcp', async (req: Request, res: Response) => {
    // A fresh Server + Transport per request (stateless mode — sessionIdGenerator: undefined)
    const server = buildServer(router);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`MCP HTTP error: ${msg}`);
      if (!res.headersSent) res.status(500).json({ error: msg });
    }
  });

  log.info('Mounted MCP HTTP transport at POST /mcp');
}
