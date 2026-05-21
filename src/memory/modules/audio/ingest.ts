// src/memory/modules/audio/ingest.ts
import { ulid } from 'ulid';
import { createHash } from 'crypto';
import path from 'path';
import type { MemoryItem, MemoryProperties } from '../../../types.js';
import type { TranscriptResult } from './transcriber.js';

export interface AudioIngestInput {
  audioPath: string;
  transcript: TranscriptResult;
  embeddingModel: string;
}

export function buildAudioItem(input: AudioIngestInput): MemoryItem {
  const now = new Date().toISOString();
  const base = path.basename(input.audioPath);
  const properties: MemoryProperties = {
    title: base,
    created_at: now,
    ingested_at: now,
    source_url: `file://${input.audioPath}`,
    custom: {
      audio_path: input.audioPath,
      duration_seconds: input.transcript.duration,
      language: input.transcript.language,
      segments: input.transcript.segments,
    },
  };
  return {
    id: ulid(),
    type: 'audio',
    source_id: `audio:${input.audioPath}`,
    content: input.transcript.full_text,
    content_hash: createHash('sha256').update(input.transcript.full_text).digest('hex'),
    properties,
    wikilinks: [],
    related_ids: [],
    embedding_model: input.embeddingModel,
  };
}
