import type { MemoryModule } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildNotionTools } from './tools.js';
import { startNotionWatcher, stopNotionWatcher } from './watcher.js';

export function createNotionModule(config: EngramConfig): MemoryModule {
  let store: MemoryStore | null = null;
  return {
    id: 'notion',
    displayName: 'Notion',
    isCustom: false,

    async onBoot(ctx) {
      store = ctx.store;
    },

    async onShutdown() {
      stopNotionWatcher();
    },

    async ingest() {
      throw new Error('notion.ingest is not used; use the ingest_notion_page MCP tool');
    },

    startWatcher() {
      if (store) startNotionWatcher(store, config);
    },

    stopWatcher() {
      stopNotionWatcher();
    },

    tools: [],
  };
}

export function buildNotionModuleTools(store: MemoryStore, config: EngramConfig) {
  return buildNotionTools(store, config);
}
