#!/usr/bin/env node
import { ENGRAM_API_BASE } from '../cloud/endpoints.js';
import { loadConfig } from '../config/index.js';
import { buildEngramRuntime, startStdioMcpServer } from '../mcp-server/server.js';
import { startWebapp } from '../webapp/server.js';
import { startBridgeClient } from '../cloud/bridge-client.js';
import { createLogger } from '../logger.js';

const log = createLogger('serve');

async function main() {
  const config = loadConfig();
  // --admin flag is deprecated: all 21 tools are now always public
  if (process.argv.includes('--admin')) {
    log.info('Note: --admin flag is no longer needed. All tools are now public by default.');
  }
  const runtime = await buildEngramRuntime(config);

  // Always start the dashboard + HTTP MCP unless --no-http
  const noHttp = process.argv.includes('--no-http');
  if (!noHttp) {
    startWebapp({
      port: config.mcp.httpPort,
      store: runtime.store,
      router: runtime.router,
    });
    log.info(
      `Local dashboard running at http://localhost:${config.mcp.httpPort} (dev tool — opt-in).` +
      ' The official dashboard is https://engram-mcp.com — sign up to access from anywhere.' +
      ' Use --no-http to start without the local web UI.',
    );
  }

  // --- Bridge Relay client (opt-in, only if user has paired) ---
  let bridgeStop: (() => void) | null = null;
  if (!noHttp && config.engramAccount) {
    const bridge = startBridgeClient({
      baseUrl: ENGRAM_API_BASE,
      localPort: config.mcp.httpPort,
    });
    bridgeStop = bridge.stop;
    log.info('Bridge Relay client started');
  }

  // Start stdio MCP if enabled
  if (config.mcp.stdio) {
    await startStdioMcpServer(runtime);
  }

  process.on('SIGTERM', async () => {
    bridgeStop?.();
    await runtime.shutdown();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    bridgeStop?.();
    await runtime.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
