import path from 'path';
import { createLogger } from '../../../logger.js';
import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { readVault } from './vault-reader.js';
import { buildObsidianItem } from './ingest.js';
import { sourceRegistry } from '../../core/source-registry.js';

const log = createLogger('obsidian:tools');

export function buildObsidianTools(
  store: MemoryStore,
  config: EngramConfig,
): MCPToolDefinition[] {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return [
    {
      name: 'add_obsidian_vault',
      description:
        'Index every markdown file in an Obsidian vault path and add to memory. One-shot ingestion.',
      inputSchema: {
        type: 'object',
        properties: {
          vault_path: {
            type: 'string',
            description: 'Absolute path to the vault root.',
          },
        },
        required: ['vault_path'],
      },
      handler: async (args) => {
        const vaultPath = path.resolve(args.vault_path as string);
        const files = await readVault(vaultPath);
        let count = 0;
        for (const file of files) {
          const item = buildObsidianItem({ file, vaultRoot: vaultPath, embeddingModel });
          await store.deleteBySourceId(item.source_id);
          await store.insert(item);
          count++;
        }
        log.info(`Ingested ${count} files from ${vaultPath}`);
        return { vault_path: vaultPath, files_ingested: count };
      },
    },
    {
      name: 'watch_obsidian_vault',
      description:
        'Add an Obsidian vault to the watched-sources list. The watcher polls the filesystem and re-ingests changed files on the fly.',
      inputSchema: {
        type: 'object',
        properties: { vault_path: { type: 'string' } },
        required: ['vault_path'],
      },
      handler: async (args) => {
        const vaultPath = path.resolve(args.vault_path as string);
        const sourceId = sourceRegistry.add({
          module_id: 'obsidian',
          external_id: vaultPath,
          display_name: path.basename(vaultPath),
          config: { vault_path: vaultPath },
        });
        // initial full ingest
        const files = await readVault(vaultPath);
        for (const file of files) {
          const item = buildObsidianItem({ file, vaultRoot: vaultPath, embeddingModel });
          await store.deleteBySourceId(item.source_id);
          await store.insert(item);
        }
        sourceRegistry.recordSync(sourceId, new Date().toISOString());
        return { source_id: sourceId, files_ingested: files.length, watching: vaultPath };
      },
    },
    {
      name: 'unwatch_obsidian_vault',
      description:
        'Remove an Obsidian vault from the watched-sources list (does not delete memories).',
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
      name: 'search_obsidian',
      description: 'Search ingested Obsidian notes by semantic similarity.',
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
          'obsidian',
          args.query as string,
          (args.limit as number) ?? 10,
        );
        return hits.map((h) => ({
          id: h.memory.id,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
          relative_path: h.memory.properties.custom?.relative_path,
        }));
      },
    },
  ];
}
