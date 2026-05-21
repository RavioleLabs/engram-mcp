import type { MemoryModule } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildDriveTools } from './tools.js';
import { startDriveWatcher, stopDriveWatcher } from './watcher.js';

export function createDriveModule(config: EngramConfig): MemoryModule {
  let store: MemoryStore | null = null;
  return {
    id: 'drive',
    displayName: 'Google Drive',
    isCustom: false,

    async onBoot(ctx) {
      store = ctx.store;
    },

    async onShutdown() {
      stopDriveWatcher();
    },

    async ingest() {
      throw new Error('drive.ingest is not used; use the ingest_drive_file MCP tool');
    },

    startWatcher() {
      if (store) startDriveWatcher(store, config);
    },

    stopWatcher() {
      stopDriveWatcher();
    },

    tools: [],
  };
}

export function buildDriveModuleTools(store: MemoryStore, config: EngramConfig) {
  return buildDriveTools(store, config);
}
