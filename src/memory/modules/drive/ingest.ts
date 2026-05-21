import { ulid } from 'ulid';
import { createHash } from 'crypto';
import type { MemoryItem, MemoryProperties } from '../../../types.js';
import type { DriveFileMetadata } from './connector.js';

export interface DriveIngestInput {
  metadata: DriveFileMetadata;
  content: string;
  embeddingModel: string;
}

export function buildDriveItem(input: DriveIngestInput): MemoryItem {
  const now = new Date().toISOString();
  const properties: MemoryProperties = {
    title: input.metadata.name,
    created_at: input.metadata.modifiedTime ?? now,
    ingested_at: now,
    source_url: `https://drive.google.com/file/d/${input.metadata.id}/view`,
    custom: {
      mime_type: input.metadata.mimeType,
      drive_file_id: input.metadata.id,
    },
  };
  return {
    id: ulid(),
    type: 'drive',
    source_id: `drive:${input.metadata.id}`,
    content: input.content,
    content_hash: createHash('sha256').update(input.content).digest('hex'),
    properties,
    wikilinks: [],
    related_ids: [],
    embedding_model: input.embeddingModel,
  };
}
