// src/memory/modules/_custom/generic-module.ts
import { ulid } from 'ulid';
import { createHash } from 'crypto';
import type { MemoryModule, MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import type { MemoryItem, MemoryProperties, IngestInput } from '../../../types.js';
import { extractWikilinks } from '../../core/wikilinks.js';
import type { CustomTypeDefinition } from './persistence.js';

function buildGenericItem(
  typeName: string,
  input: IngestInput,
  embeddingModel: string,
): MemoryItem {
  const now = new Date().toISOString();
  const properties: MemoryProperties = {
    title: input.properties?.title,
    tags: input.properties?.tags,
    created_at: input.properties?.created_at ?? now,
    ingested_at: now,
    source_url: input.properties?.source_url,
    author: input.properties?.author,
    sentiment: input.properties?.sentiment,
    action_required: input.properties?.action_required,
    expires_at: input.properties?.expires_at,
    custom: input.properties?.custom,
  };
  return {
    id: ulid(),
    type: typeName,
    source_id: input.source_id ?? `${typeName}:${Date.now()}`,
    content: input.content,
    content_hash: createHash('sha256').update(input.content).digest('hex'),
    properties,
    wikilinks: extractWikilinks(input.content),
    related_ids: [],
    embedding_model: embeddingModel,
  };
}

export function createGenericModule(def: CustomTypeDefinition, config: EngramConfig): MemoryModule {
  let store: MemoryStore | null = null;
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return {
    id: def.type_name,
    displayName: def.display_name,
    isCustom: true,

    async onBoot(ctx) {
      store = ctx.store;
    },
    async onShutdown() {},

    async ingest(input: IngestInput) {
      if (!store) throw new Error('Module not booted');
      const item = buildGenericItem(def.type_name, input, embeddingModel);
      await store.insert(item);
      return [item];
    },

    tools: [],
  };
}

export function buildGenericModuleTools(
  def: CustomTypeDefinition,
  store: MemoryStore,
  config: EngramConfig,
): MCPToolDefinition[] {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return [
    {
      name: `add_${def.type_name}`,
      description: `Add a new item to the user-defined "${def.display_name}" memory type. The calling LLM must provide title and tags directly.`,
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          custom: {
            type: 'object',
            description: 'Custom fields specific to this memory type.',
          },
        },
        required: ['content'],
      },
      handler: async (args) => {
        const item = buildGenericItem(
          def.type_name,
          {
            content: args.content as string,
            source_id: (args.source_id as string) ?? `${def.type_name}:${Date.now()}`,
            properties: {
              title: args.title as string | undefined,
              tags: args.tags as string[] | undefined,
              custom: args.custom as Record<string, unknown> | undefined,
            },
          },
          embeddingModel,
        );
        await store.insert(item);
        return { id: item.id, type: def.type_name };
      },
    },
    {
      name: `search_${def.type_name}`,
      description: `Search the user-defined "${def.display_name}" memory type by semantic similarity. The calling LLM must provide a descriptive query.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const hits = await store.search(
          def.type_name,
          args.query as string,
          (args.limit as number) ?? 10,
        );
        return hits.map((h) => ({
          id: h.memory.id,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
        }));
      },
    },
  ];
}
