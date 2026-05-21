// src/memory/modules/youtube/ingest.ts
import { ulid } from 'ulid';
import { createHash } from 'crypto';
import type { MemoryItem, MemoryProperties } from '../../../types.js';
import type { YoutubeTranscriptResult } from './transcript-fetcher.js';
import type { MemoryStore } from '../../core/store.js';
import type { EmbeddingsConfig } from '../../../config/schema.js';
import type { YoutubeConfig } from '../../../config/schema.js';

export interface IngestYouTubeOptions {
  tags?: string[];
  sourceContext?: string;
}

/**
 * Full ingest pipeline for a YouTube URL: fetch transcript → build item → insert.
 * Used by the channel watcher and playlist importer.
 */
export async function ingestYouTube(
  url: string,
  store: MemoryStore,
  embeddingsConfig: EmbeddingsConfig,
  youtubeConfig: YoutubeConfig,
  options?: IngestYouTubeOptions,
): Promise<string> {
  const { fetchTranscript } = await import('./transcript-fetcher.js');
  const transcript = await fetchTranscript(url, youtubeConfig);
  const embeddingModel = `${embeddingsConfig.provider}/${embeddingsConfig.model}`;
  const item = buildYoutubeItem({ transcript, embeddingModel });
  if (options?.tags) {
    item.properties.tags = options.tags;
  }
  await store.insert(item);
  return item.id;
}

export interface YoutubeIngestInput {
  transcript: YoutubeTranscriptResult;
  embeddingModel: string;
}

export function buildYoutubeItem(input: YoutubeIngestInput): MemoryItem {
  const now = new Date().toISOString();
  const properties: MemoryProperties = {
    title: input.transcript.title,
    created_at: now,
    ingested_at: now,
    source_url: `https://www.youtube.com/watch?v=${input.transcript.video_id}`,
    author: input.transcript.channel,
    custom: {
      video_id: input.transcript.video_id,
      language: input.transcript.language,
      segments: input.transcript.segments,
      duration_seconds:
        input.transcript.segments.length > 0
          ? input.transcript.segments[input.transcript.segments.length - 1].start +
            input.transcript.segments[input.transcript.segments.length - 1].duration
          : 0,
    },
  };
  return {
    id: ulid(),
    type: 'youtube',
    source_id: `youtube:${input.transcript.video_id}`,
    content: input.transcript.full_text,
    content_hash: createHash('sha256').update(input.transcript.full_text).digest('hex'),
    properties,
    wikilinks: [],
    related_ids: [],
    embedding_model: input.embeddingModel,
  };
}
