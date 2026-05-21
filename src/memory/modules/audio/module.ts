// src/memory/modules/audio/module.ts
import type { MemoryModule } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildAudioTools } from './tools.js';

export function createAudioModule(_config: EngramConfig): MemoryModule {
  return {
    id: 'audio',
    displayName: 'Audio (Whisper)',
    isCustom: false,

    async onBoot() {},
    async onShutdown() {},

    async ingest() {
      throw new Error('audio.ingest is not used; use add_audio_file MCP tool');
    },

    tools: [],
  };
}

export function buildAudioModuleTools(store: MemoryStore, config: EngramConfig) {
  return buildAudioTools(store, config);
}
