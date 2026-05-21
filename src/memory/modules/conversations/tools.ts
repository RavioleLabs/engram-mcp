import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildExchangeItem } from './ingest.js';

export function buildConversationsTools(
  store: MemoryStore,
  config: EngramConfig,
): MCPToolDefinition[] {
  return [
    {
      name: 'remember_exchange',
      description:
        'Save a user/assistant exchange to long-term memory. Call this after meaningful conversations the user may want to recall later. Provide both messages verbatim. IMPORTANT: you (the calling LLM) must ALSO provide `title` (3-7 words summarizing the exchange) and 3-5 `tags`. EngramMCP does not run an LLM internally — you are the LLM that understands this exchange, so you must label it.',
      inputSchema: {
        type: 'object',
        properties: {
          user_message: { type: 'string', description: 'The user\'s message verbatim' },
          assistant_message: {
            type: 'string',
            description: 'The assistant\'s reply verbatim',
          },
          agent: {
            type: 'string',
            description: 'Identifier for the agent runtime (e.g. claude-code, cursor)',
          },
          title: {
            type: 'string',
            description: 'Short title summarizing the exchange (3-7 words). Required for good retrieval.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '3-5 lowercase keywords. Required for good retrieval.',
          },
        },
        required: ['user_message', 'assistant_message'],
      },
      handler: async (args) => {
        const title = args.title as string | undefined;
        const tags = args.tags as string[] | undefined;
        const item = buildExchangeItem(
          {
            user_message: args.user_message as string,
            assistant_message: args.assistant_message as string,
            agent: args.agent as string | undefined,
            properties: { title, tags },
          },
          `${config.embeddings.provider}/${config.embeddings.model}`,
        );
        await store.insert(item);
        const response: Record<string, unknown> = { id: item.id, type: item.type };
        if (!title || !tags || tags.length === 0) {
          response.hint =
            'You did not provide title and/or tags. Consider calling update with a 3-7 word title and 3-5 tags so this exchange is retrievable later.';
        }
        return response;
      },
    },
    {
      name: 'search_conversations',
      description:
        'Search past user/assistant conversations by semantic similarity. Use when looking for what was discussed or decided previously.',
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
          'conversations',
          args.query as string,
          (args.limit as number) ?? 10,
        );
        return hits.map((h) => ({
          id: h.memory.id,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
          tags: h.memory.properties.tags,
          agent: h.memory.properties.author,
          created_at: h.memory.properties.created_at,
        }));
      },
    },
  ];
}
