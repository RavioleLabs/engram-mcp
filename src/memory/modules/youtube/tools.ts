// src/memory/modules/youtube/tools.ts
import { createLogger } from '../../../logger.js';
import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { fetchTranscript } from './transcript-fetcher.js';
import { buildYoutubeItem } from './ingest.js';
import { sourceRegistry } from '../../core/source-registry.js';

const log = createLogger('youtube:tools');

export function buildYoutubeTools(store: MemoryStore, config: EngramConfig): MCPToolDefinition[] {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return [
    {
      name: 'add_youtube_url',
      description:
        'Fetch the transcript of a YouTube video and add it to memory. Works for any public video with captions (auto-generated or human). The video title from the page is used automatically as the title field. You (the calling LLM) should provide additional context like tags when calling suggest_properties afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'YouTube watch URL or video id.',
          },
        },
        required: ['url'],
      },
      handler: async (args) => {
        const url = args.url as string;
        const transcript = await fetchTranscript(url, config.youtube);
        const item = buildYoutubeItem({ transcript, embeddingModel });
        await store.insert(item);
        log.info(
          `Ingested YouTube ${transcript.title} (${transcript.segments.length} segments) as ${item.id}`,
        );
        return {
          id: item.id,
          title: transcript.title,
          channel: transcript.channel,
          segments: transcript.segments.length,
        };
      },
    },
    {
      name: 'search_youtube',
      description:
        'Search ingested YouTube transcripts by semantic similarity. Returns video metadata + transcript snippets. Use this to find previously ingested YouTube videos by content.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language query to search YouTube transcripts.' },
          limit: { type: 'number', default: 10, description: 'Maximum number of results to return.' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const hits = await store.search(
          'youtube',
          args.query as string,
          (args.limit as number) ?? 10,
        );
        return hits.map((h) => ({
          id: h.memory.id,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
          channel: h.memory.properties.author,
          source_url: h.memory.properties.source_url,
        }));
      },
    },

    // ── watch_youtube_channel ───────────────────────────────────────────────
    {
      name: 'watch_youtube_channel',
      description:
        'Subscribe to a YouTube channel. EngramMCP will poll the channel RSS feed periodically ' +
        '(default 6h, configurable via youtube.channelPollIntervalMs in ~/.engram/config.json) ' +
        'and automatically ingest new videos as YouTube memories. ' +
        'Call with the channel URL (e.g. https://www.youtube.com/@handle) or channel ID (UCxxx). ' +
        'Use this when a user says "watch this channel" or "keep track of new videos from X". ' +
        'Providing a descriptive channelName improves search retrieval.',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: {
            type: 'string',
            description:
              'YouTube channel ID (starts with UC…) OR full channel URL (e.g. https://www.youtube.com/@handle). Required.',
          },
          channelName: {
            type: 'string',
            description: 'Human-readable channel name. Used as a tag on ingested memories.',
          },
        },
        required: ['channelId'],
      },
      handler: async (args) => {
        const { channelId: rawChannelId, channelName: rawChannelName } = args as {
          channelId: string;
          channelName?: string;
        };
        const { resolveChannelId } = await import('./watcher.js');

        const channelId = await resolveChannelId(rawChannelId);
        const existing = sourceRegistry.listEnabled('youtube').find(
          (s) => s.external_id === channelId,
        );
        if (existing) {
          return {
            content: [
              { type: 'text', text: `Channel ${channelId} is already being watched.` },
            ],
          };
        }

        sourceRegistry.add({
          module_id: 'youtube',
          external_id: channelId,
          display_name: rawChannelName ?? channelId,
          config: { channelId, channelName: rawChannelName ?? channelId },
        });

        return {
          content: [
            {
              type: 'text',
              text: `Now watching channel ${rawChannelName ?? channelId} (${channelId}). New videos will be ingested automatically.`,
            },
          ],
        };
      },
    },

    // ── unwatch_youtube_channel ─────────────────────────────────────────────
    {
      name: 'unwatch_youtube_channel',
      description:
        'Stop watching a YouTube channel. Future videos will not be ingested. Existing memories are kept.',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'Channel ID to unwatch (UCxxx).' },
        },
        required: ['channelId'],
      },
      handler: async (args) => {
        const { channelId } = args as { channelId: string };
        const sources = sourceRegistry.list('youtube');
        const found = sources.find((s) => s.external_id === channelId);
        if (found) {
          sourceRegistry.remove(found.id);
          return {
            content: [
              { type: 'text', text: `Stopped watching channel ${channelId}.` },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `Channel ${channelId} was not in the watch list.`,
            },
          ],
        };
      },
    },

    // ── import_watch_later ──────────────────────────────────────────────────
    {
      name: 'import_watch_later',
      description:
        'Bulk-import a YouTube playlist (paste the playlist URL). Fetches video IDs from the playlist page HTML and ingests each video as a YouTube memory. ' +
        'Note: Watch Later (WL) is a private playlist — the user must make it temporarily public or use a different playlist URL. ' +
        'Use this when a user says "import my watch later" or "ingest this playlist".',
      inputSchema: {
        type: 'object',
        properties: {
          playlistUrl: {
            type: 'string',
            description:
              'Full YouTube playlist URL, e.g. https://www.youtube.com/playlist?list=PLxxxxxx',
          },
          limit: {
            type: 'number',
            description:
              'Maximum number of videos to import (default 50, max 200). Older videos are skipped first.',
          },
        },
        required: ['playlistUrl'],
      },
      handler: async (args) => {
        const { playlistUrl, limit: rawLimit } = args as { playlistUrl: string; limit?: number };
        const { importPlaylist } = await import('./watcher.js');
        const result = await importPlaylist(
          playlistUrl,
          store,
          config.embeddings,
          config.youtube,
          rawLimit ?? 50,
        );
        return {
          content: [
            {
              type: 'text',
              text:
                result.imported > 0
                  ? `Imported ${result.imported} videos from the playlist. ${result.skipped} skipped (already ingested or failed).`
                  : `No new videos found in the playlist. Either the playlist is empty, private, or all videos were already ingested.`,
            },
          ],
        };
      },
    },
  ];
}
