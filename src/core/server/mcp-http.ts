import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../logger.js';
import type { ToolRouter } from './tool-router.js';
import { ENGRAM_INSTRUCTIONS } from './instructions.js';

const log = createLogger('mcp-http');

// SECURITY: HTTP MCP transport requires a Bearer token to prevent any local
// process (browser extension, malicious npm dep running in another project)
// from calling tools via http://127.0.0.1:7777/mcp.
// Token is auto-generated at first startup and persisted to ~/.engram/http-token.
function loadOrGenerateHttpToken(): string {
  const tokenPath = path.join(os.homedir(), '.engram', 'http-token');
  if (existsSync(tokenPath)) {
    try {
      const t = readFileSync(tokenPath, 'utf-8').trim();
      if (t.length >= 32) return t;
    } catch {
      /* fall through and regenerate */
    }
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  log.info(`Generated HTTP MCP auth token at ${tokenPath}`);
  return token;
}

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
  const httpToken = loadOrGenerateHttpToken();

  // Bearer-token auth middleware — every /mcp request must present the token.
  const requireToken = (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    // Constant-time compare to avoid timing leaks
    if (presented.length !== httpToken.length || !timingSafeEqual(presented, httpToken)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'HTTP MCP requires Bearer token. Find it at ~/.engram/http-token.',
      });
      return;
    }
    next();
  };

  app.use('/mcp', express.json({ limit: '4mb' }));
  app.post('/mcp', requireToken, async (req: Request, res: Response) => {
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

  log.info('Mounted MCP HTTP transport at POST /mcp (Bearer token required, see ~/.engram/http-token)');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
