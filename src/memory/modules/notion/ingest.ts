import { ulid } from 'ulid';
import { createHash } from 'crypto';
import type { MemoryItem, MemoryProperties } from '../../../types.js';
import type { NotionPageMetadata } from './connector.js';

export interface NotionIngestInput {
  metadata: NotionPageMetadata;
  content: string;
  embeddingModel: string;
}

export function buildNotionItem(input: NotionIngestInput): MemoryItem {
  const now = new Date().toISOString();
  const properties: MemoryProperties = {
    title: input.metadata.title,
    created_at: input.metadata.last_edited_time,
    ingested_at: now,
    source_url: input.metadata.url,
    custom: { notion_page_id: input.metadata.id },
  };
  return {
    id: ulid(),
    type: 'notion',
    source_id: `notion:${input.metadata.id}`,
    content: input.content,
    content_hash: createHash('sha256').update(input.content).digest('hex'),
    properties,
    wikilinks: [],
    related_ids: [],
    embedding_model: input.embeddingModel,
  };
}
