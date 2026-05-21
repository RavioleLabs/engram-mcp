import type { MemoryModule, MemoryModuleContext } from '../../core/module-interface.js';
import type { EngramConfig } from '../../../config/schema.js';
import type { IngestInput } from '../../../types.js';
import { buildExchangeItem } from './ingest.js';
import { buildConversationsTools } from './tools.js';
import type { MemoryStore } from '../../core/store.js';

export function createConversationsModule(config: EngramConfig): MemoryModule {
  let ctx: MemoryModuleContext | null = null;
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return {
    id: 'conversations',
    displayName: 'Conversations',
    isCustom: false,

    async onBoot(c) {
      ctx = c;
    },

    async onShutdown() {},

    async ingest(input: IngestInput) {
      if (!ctx) throw new Error('Module not booted');
      // Expect input.content to be JSON: { user_message, assistant_message }
      let payload: { user_message?: string; assistant_message?: string };
      try {
        payload = JSON.parse(input.content);
      } catch {
        throw new Error(
          'conversations.ingest expects content to be JSON with {user_message, assistant_message}',
        );
      }
      if (!payload.user_message || !payload.assistant_message) {
        throw new Error('conversations.ingest requires user_message and assistant_message');
      }
      const item = buildExchangeItem(
        {
          user_message: payload.user_message,
          assistant_message: payload.assistant_message,
          source_id: input.source_id,
          properties: input.properties,
        },
        embeddingModel,
      );
      await ctx.store.insert(item);
      return [item];
    },

    tools: [],
  };
}

export function buildConversationsModuleTools(store: MemoryStore, config: EngramConfig) {
  return buildConversationsTools(store, config);
}
