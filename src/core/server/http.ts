import express, { type Express } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../logger.js';
import { mountMcpHttp } from './mcp-http.js';
import { mountWebSocket } from './websocket.js';
import { memoriesApi } from '../../server/api/memories.js';
import { sourcesApi } from '../../server/api/sources.js';
import { typesApi } from '../../server/api/types.js';
import { viewsApi } from '../../server/api/views.js';
import { dailyApi } from '../../server/api/daily.js';
import { settingsApi } from '../../server/api/settings.js';
import { reindexApi } from '../../server/api/reindex.js';
import { syncStatusRouter } from '../../server/api/sync-status.js';
import { graphApi } from '../../server/api/graph.js';
import { integrationsApi } from '../../server/api/integrations.js';
import { versionApi } from '../../server/api/version.js';
import { loadConfig } from '../../config/index.js';
import { buildTeamRouter } from '../../webapp/api/team.js';
import type { MemoryStore } from '../../memory/core/store.js';
import type { ToolRouter } from './tool-router.js';

const log = createLogger('webapp');

export interface WebappOptions {
  port: number;
  store: MemoryStore;
  router: ToolRouter;
  clientDistDir?: string;
  /** Optional: master key for workspace key-wrapping endpoints */
  masterKey?: Uint8Array;
  dataDir?: string;
}

export function startWebapp(options: WebappOptions): { app: Express; server: http.Server } {
  const app = express();
  app.use(express.json({ limit: '4mb', strict: false }));

  // Permissive CORS for localhost dev (any localhost port)
  app.use((req, res, next) => {
    const origin = req.headers.origin ?? '';
    if (
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
    }
    next();
  });

  // Localhost-only access
  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (
      !host.startsWith('localhost:') &&
      !host.startsWith('127.0.0.1:') &&
      host !== 'localhost' &&
      host !== '127.0.0.1'
    ) {
      res.status(403).json({ error: 'engram-mcp dashboard only accepts localhost' });
      return;
    }
    next();
  });

  // REST API
  app.use('/api/memories', memoriesApi(options.store));
  app.use('/api/sources', sourcesApi(options.store));
  app.use('/api/types', typesApi());
  app.use('/api/views', viewsApi());
  app.use('/api/daily', dailyApi());
  app.use('/api/settings', settingsApi());
  app.use('/api/reindex', reindexApi());
  app.use('/api/graph', graphApi(options.store));
  app.use(
    '/api/integrations',
    integrationsApi(() => loadConfig()),
  );
  app.use('/api/version', versionApi());
  app.use(syncStatusRouter());

  // Workspace local API (key wrapping for browser invite flow)
  if (options.masterKey && options.dataDir) {
    app.use(
      '/api/team',
      buildTeamRouter({ dataDir: options.dataDir, masterKey: options.masterKey }),
    );
    log.info('Workspace /api/team endpoints registered');
  }

  // MCP HTTP transport
  mountMcpHttp(app, options.router);

  // Static client (production)
  const clientDist =
    options.clientDistDir ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/mcp|\/ws).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  const server = http.createServer(app);
  mountWebSocket(server, options.store);

  server.listen(options.port, '127.0.0.1', () => {
    log.info(`Dashboard listening on http://localhost:${options.port}`);
  });

  return { app, server };
}
