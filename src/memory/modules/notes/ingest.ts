import { ulid } from 'ulid';
import { createHash } from 'crypto';
import type { MemoryItem, IngestInput, MemoryProperties } from '../../../types.js';
import { extractWikilinks } from '../../core/wikilinks.js';

export function buildNoteItem(input: IngestInput, embeddingModel: string): MemoryItem {
  const now = new Date().toISOString();
  const properties: MemoryProperties = {
    created_at: input.properties?.created_at ?? now,
    ingested_at: now,
    title: input.properties?.title,
    tags: input.properties?.tags,
    source_url: input.properties?.source_url,
    author: input.properties?.author,
    sentiment: input.properties?.sentiment,
    action_required: input.properties?.action_required,
    expires_at: input.properties?.expires_at,
    custom: input.properties?.custom,
  };

  return {
    id: ulid(),
    type: 'notes',
    source_id: input.source_id,
    content: input.content,
    content_hash: createHash('sha256').update(input.content).digest('hex'),
    properties,
    wikilinks: extractWikilinks(input.content),
    related_ids: [],
    embedding_model: embeddingModel,
  };
}
