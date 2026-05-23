import { createLogger } from '../../../logger.js';
import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { searchPages, getPageMetadata, fetchPageText } from './connector.js';
import { startNotionOAuthFlow, isNotionConnected, getNotionWorkspace } from './oauth.js';
import { buildNotionItem } from './ingest.js';
import { sourceRegistry } from '../../core/source-registry.js';

const log = createLogger('notion:tools');

export function buildNotionTools(store: MemoryStore, config: EngramConfig): MCPToolDefinition[] {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return [
    {
      name: 'connect_notion',
      description:
        'Start a Notion OAuth flow. Returns an auth URL the user opens in a browser. After consent, tokens are saved locally (workspace-scoped).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (isNotionConnected()) {
          const ws = getNotionWorkspace();
          return { already_connected: true, workspace: ws?.name };
        }
        const flow = await startNotionOAuthFlow(config);
        const result = await Promise.race([
          flow.waitForCallback.then((t) => ({ connected: true, workspace: t.workspace_name })),
          new Promise<{ timeout: boolean }>((resolve) =>
            setTimeout(() => resolve({ timeout: true }), 300_000),
          ),
        ]);
        return { auth_url: flow.authUrl, ...result };
      },
    },
    {
      name: 'list_notion_pages',
      description: "Search the user's Notion workspace for pages.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 25 },
        },
      },
      handler: async (args) => {
        if (!isNotionConnected()) return { error: 'Notion not connected' };
        return await searchPages((args.query as string) ?? '', (args.limit as number) ?? 25);
      },
    },
    {
      name: 'ingest_notion_page',
      description: 'Fetch one Notion page now and index it. No watching.',
      inputSchema: {
        type: 'object',
        properties: { page_id: { type: 'string' } },
        required: ['page_id'],
      },
      handler: async (args) => {
        const meta = await getPageMetadata(args.page_id as string);
        const content = await fetchPageText(meta.id);
        const item = buildNotionItem({ metadata: meta, content, embeddingModel });
        await store.insert(item);
        log.info(`Ingested Notion page ${meta.title} as ${item.id}`);
        return { id: item.id, title: meta.title };
      },
    },
    {
      name: 'watch_notion_page',
      description: 'Add a Notion page to the watched-sources list. Re-synced every 15 min.',
      inputSchema: {
        type: 'object',
        properties: { page_id: { type: 'string' } },
        required: ['page_id'],
      },
      handler: async (args) => {
        const meta = await getPageMetadata(args.page_id as string);
        const sourceId = sourceRegistry.add({
          module_id: 'notion',
          external_id: meta.id,
          display_name: meta.title,
        });
        const content = await fetchPageText(meta.id);
        const item = buildNotionItem({ metadata: meta, content, embeddingModel });
        await store.insert(item);
        sourceRegistry.recordSync(sourceId, meta.last_edited_time);
        return { source_id: sourceId, watching: meta.title };
      },
    },
    {
      name: 'unwatch_notion_page',
      description: 'Remove a Notion page from the watched list.',
      inputSchema: {
        type: 'object',
        properties: { source_id: { type: 'string' } },
        required: ['source_id'],
      },
      handler: async (args) => {
        sourceRegistry.remove(args.source_id as string);
        return { removed: true };
      },
    },
    {
      name: 'search_notion',
      description: 'Search ingested Notion pages by semantic similarity.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number', default: 10 } },
        required: ['query'],
      },
      handler: async (args) => {
        const hits = await store.search(
          'notion',
          args.query as string,
          (args.limit as number) ?? 10,
        );
        return hits.map((h) => ({
          id: h.memory.id,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
          source_url: h.memory.properties.source_url,
        }));
      },
    },
  ];
}
