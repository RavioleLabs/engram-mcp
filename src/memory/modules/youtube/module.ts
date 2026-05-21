// src/memory/modules/youtube/module.ts
import type { MemoryModule } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildYoutubeTools } from './tools.js';
import { startChannelCron } from './watcher.js';

export function createYoutubeModule(_config: EngramConfig): MemoryModule {
  return {
    id: 'youtube',
    displayName: 'YouTube',
    isCustom: false,

    async onBoot() {},
    async onShutdown() {},

    async ingest() {
      throw new Error('youtube.ingest is not used; use add_youtube_url MCP tool');
    },

    tools: [],
  };
}

export function buildYoutubeModuleTools(store: MemoryStore, config: EngramConfig) {
  return buildYoutubeTools(store, config);
}

/**
 * Start the YouTube channel cron — call this after the server is fully
 * initialized and the store is available.
 */
export function startYoutubeChannelCron(store: MemoryStore, config: EngramConfig): void {
  startChannelCron(store, config.embeddings, config.youtube);
}
