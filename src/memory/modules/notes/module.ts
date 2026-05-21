import type { MemoryModule, MemoryModuleContext } from '../../core/module-interface.js';
import type { EngramConfig } from '../../../config/schema.js';
import type { IngestInput } from '../../../types.js';
import { buildNoteItem } from './ingest.js';
import { buildNotesTools } from './tools.js';

export function createNotesModule(config: EngramConfig): MemoryModule {
  let ctx: MemoryModuleContext | null = null;
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return {
    id: 'notes',
    displayName: 'Notes',
    isCustom: false,

    async onBoot(c) {
      ctx = c;
    },

    async onShutdown() {},

    async ingest(input: IngestInput) {
      if (!ctx) throw new Error('Module not booted');
      const item = buildNoteItem(input, embeddingModel);
      await ctx.store.insert(item);
      return [item];
    },

    tools: [], // populated via setTools after boot — see registry wiring
    // We expose a builder so the server can build tools post-boot with store binding
  };
}

export function buildNotesModuleTools(
  store: import('../../core/store.js').MemoryStore,
  config: EngramConfig,
) {
  return buildNotesTools(store, config);
}
