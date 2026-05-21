import type { MemoryModule } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildObsidianTools } from './tools.js';
import { startObsidianWatchers, stopObsidianWatchers } from './watcher.js';

export function createObsidianModule(config: EngramConfig): MemoryModule {
  let store: MemoryStore | null = null;
  return {
    id: 'obsidian',
    displayName: 'Obsidian Vault',
    isCustom: false,

    async onBoot(ctx) {
      store = ctx.store;
    },

    async onShutdown() {
      stopObsidianWatchers();
    },

    async ingest() {
      throw new Error('obsidian.ingest is not used; use add_obsidian_vault MCP tool');
    },

    startWatcher() {
      if (store) startObsidianWatchers(store, config);
    },

    stopWatcher() {
      stopObsidianWatchers();
    },

    tools: [],
  };
}

export function buildObsidianModuleTools(store: MemoryStore, config: EngramConfig) {
  return buildObsidianTools(store, config);
}
