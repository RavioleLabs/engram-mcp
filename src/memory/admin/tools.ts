// src/memory/admin/tools.ts
// Admin-only tools: OAuth setup + heavy bulk operations.
// Only registered when serve.ts is started with --admin flag.
// These require browser callbacks or are too heavyweight for regular agent use.
//
// Public surface now includes: watch, unwatch, list_sources, create_type, delete_type.
// Admin surface keeps ONLY OAuth-initiating tools + heavy bulk ops:
//   connect_drive, connect_notion, list_drive_files, list_notion_pages, import_watch_later
import { createLogger } from '../../logger.js';
import type { MCPToolDefinition } from '../core/module-interface.js';
import type { MemoryStore } from '../core/store.js';
import type { EngramConfig } from '../../config/schema.js';
import { ToolRouter } from '../../mcp-server/tool-router.js';

const log = createLogger('admin-tools');

export function buildAdminTools(
  store: MemoryStore,
  config: EngramConfig,
  router: ToolRouter,
): MCPToolDefinition[] {
  // Suppress unused var warning — router is kept in signature for API compatibility
  void store;
  void router;

  return [
    // ── Drive OAuth ───────────────────────────────────────────────────────────
    {
      name: 'connect_drive',
      description: [
        'Start a Google Drive OAuth flow. Opens a browser callback to localhost:7777/oauth/drive.',
        'ADMIN ONLY: requires a browser — agents cannot drive this flow.',
        'Returns auth URL for the user to open. After consent, tokens are saved locally.',
        'After connecting, agents can use watch(source_type: "drive", ...) without admin.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { startDriveOAuthFlow, isDriveConnected } = await import('../modules/drive/oauth.js');
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

    // ── Drive file listing ────────────────────────────────────────────────────
    {
      name: 'list_drive_files',
      description: [
        'List recent Google Drive files. Heavy Drive API read — admin use.',
        'ADMIN ONLY: raw file enumeration rarely needed by agents. Use ingest(drive_url) or watch(drive, file_id) instead.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 25 },
        },
      },
      handler: async (args) => {
        const { listFiles } = await import('../modules/drive/connector.js');
        const { files } = await listFiles(config, {
          query: args.query as string | undefined,
          pageSize: (args.limit as number) ?? 25,
        });
        return files.map((f: { id: string; name: string; mimeType: string; modifiedTime: string }) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
        }));
      },
    },

    // ── Notion OAuth ──────────────────────────────────────────────────────────
    {
      name: 'connect_notion',
      description: [
        'Start a Notion OAuth flow. Opens a browser callback to localhost:7777/oauth/notion.',
        'ADMIN ONLY: requires a browser — agents cannot drive this flow.',
        'After connecting, agents can use watch(source_type: "notion", ...) without admin.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { startNotionOAuthFlow, isNotionConnected, getNotionWorkspace } = await import('../modules/notion/oauth.js');
        if (isNotionConnected()) {
          const ws = getNotionWorkspace();
          return { already_connected: true, workspace: ws?.name };
        }
        const flow = await startNotionOAuthFlow(config);
        const result = await Promise.race([
          flow.waitForCallback.then((t: { workspace_name: string }) => ({ connected: true, workspace: t.workspace_name })),
          new Promise<{ timeout: boolean }>((resolve) =>
            setTimeout(() => resolve({ timeout: true }), 300_000),
          ),
        ]);
        return { auth_url: flow.authUrl, ...result };
      },
    },

    // ── Notion page listing ───────────────────────────────────────────────────
    {
      name: 'list_notion_pages',
      description: [
        'Search Notion workspace for pages. Heavy Notion API read — admin use.',
        'ADMIN ONLY: raw page enumeration rarely needed by agents. Use ingest(notion_url) or watch(notion, page_id) instead.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 25 },
        },
      },
      handler: async (args) => {
        const { searchPages } = await import('../modules/notion/connector.js');
        const { isNotionConnected } = await import('../modules/notion/oauth.js');
        if (!isNotionConnected()) return { error: 'Notion not connected' };
        return await searchPages(
          (args.query as string) ?? '',
          (args.limit as number) ?? 25,
        );
      },
    },

    // ── YouTube bulk import ───────────────────────────────────────────────────
    {
      name: 'import_watch_later',
      description: [
        'Bulk-import a YouTube playlist (public URL). Slow — can take minutes for large playlists.',
        'ADMIN ONLY: not suitable for real-time agent use. Use ingest(youtube_url) for individual videos.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          playlistUrl: { type: 'string' },
          limit: { type: 'number', description: 'Max videos (default 50).' },
        },
        required: ['playlistUrl'],
      },
      handler: async (args) => {
        const { importPlaylist } = await import('../modules/youtube/watcher.js');
        const result = await importPlaylist(
          args.playlistUrl as string,
          store,
          config.embeddings,
          config.youtube,
          (args.limit as number) ?? 50,
        );
        return result;
      },
    },
  ];
}
