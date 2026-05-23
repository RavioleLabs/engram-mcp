// src/tools/index.ts
// Top-level tool aggregator.
// All 21 tools are always public — no --admin flag needed.
import { createLogger } from '../core/logger.js';
import type { ToolRouter } from '../core/server/tool-router.js';
import type { MemoryStore } from '../memory/core/store.js';
import type { EngramConfig } from '../config/schema.js';

import { buildPublicTools } from '../memory/public/tools.js';
import { loadAndRegisterCustomTypes } from '../memory/modules/_custom/tools.js';

const log = createLogger('tools');

// Re-export the canonical EngramRuntime from core to keep in sync
export type { EngramRuntime } from '../core/server/mcp-handler.js';

/** Convenience interface for the standalone registerAllTools helper. */
export interface RegisterAllToolsInput {
  store: MemoryStore;
  router: ToolRouter;
  config: EngramConfig;
  /** @deprecated All tools are now always public. This flag is ignored. */
  adminMode?: boolean;
}

// Module-level router reference for dynamic access (best-effort)
let _globalRouter: ToolRouter | null = null;

/** Returns the active ToolRouter if one has been registered (best-effort). */
export function getGlobalRouter(): ToolRouter | null {
  return _globalRouter;
}

/**
 * Register all tools onto the router.
 * - All 21 public tools from memory/public/tools.ts (OAuth + bulk ops now public)
 * - Custom types: loaded from SQLite and registered on boot.
 * - Private extensions: loaded from src/private/ if present (gitignored, hosted builds only).
 */
export async function registerAllTools(runtime: RegisterAllToolsInput): Promise<void> {
  const { store, router, config } = runtime;
  _globalRouter = router;

  // Full public surface (21 tools)
  router.registerMany(buildPublicTools(store, config));
  loadAndRegisterCustomTypes(store, config, router);

  // Private extensions (premium/hosted only — gitignored).
  try {
    const privatePath = new URL('../private/index.js', import.meta.url).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import(/* @vite-ignore */ privatePath)) as any;
    await (mod.registerPrivateExtensions as (ctx: typeof runtime) => Promise<void>)(runtime);
    log.info('Private extensions loaded');
  } catch {
    log.debug('No private extensions — OSS build');
  }
}
