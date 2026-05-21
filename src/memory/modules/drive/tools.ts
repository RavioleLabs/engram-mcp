import { createLogger } from '../../../logger.js';
import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { startDriveOAuthFlow, isDriveConnected } from './oauth.js';
import { getFileMetadata, downloadFileContent, listFiles } from './connector.js';
import { buildDriveItem } from './ingest.js';
import { sourceRegistry } from '../../core/source-registry.js';

const log = createLogger('drive:tools');

export function buildDriveTools(store: MemoryStore, config: EngramConfig): MCPToolDefinition[] {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return [
    {
      name: 'connect_drive',
      description:
        'Start a Google Drive OAuth flow. Returns an auth URL the user must open in their browser. After the user grants access, tokens are saved locally.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (isDriveConnected()) return { already_connected: true };
        const flow = await startDriveOAuthFlow(config);
        const result = await Promise.race([
          flow.waitForCallback.then(() => ({ connected: true })),
          new Promise<{ timeout: boolean }>((resolve) =>
            setTimeout(() => resolve({ timeout: true }), 300_000),
          ),
        ]);
        return { auth_url: flow.authUrl, ...result };
      },
    },
    {
      name: 'list_drive_files',
      description: 'List recent files from Google Drive.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional Drive query (e.g. "name contains \'roadmap\'")',
          },
          limit: { type: 'number', default: 25 },
        },
      },
      handler: async (args) => {
        const { files } = await listFiles(config, {
          query: args.query as string | undefined,
          pageSize: (args.limit as number) ?? 25,
        });
        return files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
        }));
      },
    },
    {
      name: 'ingest_drive_file',
      description: 'Fetch a Drive file by id, transcribe text, index into memory once. No watching.',
      inputSchema: {
        type: 'object',
        properties: { file_id: { type: 'string' } },
        required: ['file_id'],
      },
      handler: async (args) => {
        const fileId = args.file_id as string;
        const meta = await getFileMetadata(fileId, config);
        const content = await downloadFileContent(fileId, meta.mimeType, config);
        if (!content) return { skipped: true, reason: 'unsupported mimeType' };
        const item = buildDriveItem({ metadata: meta, content, embeddingModel });
        await store.insert(item);
        log.info(`Ingested Drive file ${meta.name} as memory ${item.id}`);
        return { id: item.id, title: meta.name };
      },
    },
    {
      name: 'watch_drive_file',
      description: 'Add a Drive file to the watched-sources list. The watcher will re-sync every 15 minutes.',
      inputSchema: {
        type: 'object',
        properties: { file_id: { type: 'string' } },
        required: ['file_id'],
      },
      handler: async (args) => {
        const fileId = args.file_id as string;
        const meta = await getFileMetadata(fileId, config);
        const sourceId = sourceRegistry.add({
          module_id: 'drive',
          external_id: fileId,
          display_name: meta.name,
          config: { mimeType: meta.mimeType },
        });
        const content = await downloadFileContent(fileId, meta.mimeType, config);
        if (content) {
          const item = buildDriveItem({ metadata: meta, content, embeddingModel });
          await store.insert(item);
          sourceRegistry.recordSync(sourceId, meta.modifiedTime);
        }
        return { source_id: sourceId, watching: meta.name };
      },
    },
    {
      name: 'unwatch_drive_file',
      description: 'Remove a Drive file from the watched-sources list.',
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
      name: 'search_drive',
      description: 'Search ingested Google Drive documents by semantic similarity.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number', default: 10 } },
        required: ['query'],
      },
      handler: async (args) => {
        const hits = await store.search(
          'drive',
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
