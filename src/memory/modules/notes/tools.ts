import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildNoteItem } from './ingest.js';

export function buildNotesTools(store: MemoryStore, config: EngramConfig): MCPToolDefinition[] {
  return [
    {
      name: 'add_note',
      description:
        'Add a free-form text note to memory. Use this when the user wants to save a thought, idea, or piece of text. IMPORTANT: you (the calling LLM) should ALWAYS provide a short `title` (3-7 words summarizing the content) and 3-5 lowercase `tags`. EngramMCP does not run an LLM internally — you are the LLM that understands this content, so you must label it. Memories without title/tags are harder to retrieve later.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The note text (verbatim)' },
          title: {
            type: 'string',
            description:
              'Short title summarizing the note (3-7 words). Required for good retrieval.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '3-5 lowercase keywords. Required for good retrieval.',
          },
          source_id: { type: 'string', description: 'Optional source identifier' },
        },
        required: ['content'],
      },
      handler: async (args) => {
        const content = args.content as string;
        const source_id = (args.source_id as string) ?? `manual:${Date.now()}`;
        const title = args.title as string | undefined;
        const tags = args.tags as string[] | undefined;
        const item = buildNoteItem(
          {
            content,
            source_id,
            properties: { title, tags },
          },
          `${config.embeddings.provider}/${config.embeddings.model}`,
        );
        await store.insert(item);
        const response: Record<string, unknown> = { id: item.id, type: item.type };
        if (!title || !tags || tags.length === 0) {
          response.hint =
            'You did not provide title and/or tags. Consider calling update with a 3-7 word title and 3-5 tags so this memory is retrievable later.';
        }
        return response;
      },
    },
    {
      name: 'search_notes',
      description:
        "Search the user's notes by semantic similarity. Returns ranked results with snippets.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const query = args.query as string;
        const limit = (args.limit as number) ?? 10;
        const hits = await store.search('notes', query, limit);
        return hits.map((h) => ({
          id: h.memory.id,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
          tags: h.memory.properties.tags,
        }));
      },
    },
  ];
}
