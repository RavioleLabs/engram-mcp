// src/memory/modules/audio/tools.ts
import { createLogger } from '../../../logger.js';
import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { transcribeAudio } from './transcriber.js';
import { buildAudioItem } from './ingest.js';

const log = createLogger('audio:tools');

export function buildAudioTools(store: MemoryStore, config: EngramConfig): MCPToolDefinition[] {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return [
    {
      name: 'add_audio_file',
      description:
        'Transcribe an audio file using local Whisper.cpp and add it to memory as a searchable transcript. Supports common audio formats (wav, mp3, m4a, ogg). The transcript is indexed under the `audio` memory type. The filename is used as the title; you (the calling LLM) can later call update to add better title/tags after reviewing the transcript via suggest_properties.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the audio file on the local filesystem.',
          },
        },
        required: ['path'],
      },
      handler: async (args) => {
        const audioPath = args.path as string;
        const transcript = await transcribeAudio(audioPath, config.whisper, config);
        const item = buildAudioItem({ audioPath, transcript, embeddingModel });
        await store.insert(item);
        log.info(
          `Ingested audio ${audioPath} as memory ${item.id} (${
            transcript.segments.length
          } segments, ${transcript.duration.toFixed(1)}s)`,
        );
        return {
          id: item.id,
          duration: transcript.duration,
          segments: transcript.segments.length,
          full_text_preview: transcript.full_text.slice(0, 200),
        };
      },
    },
    {
      name: 'search_audio',
      description:
        'Search transcribed audio memories by semantic similarity. Returns matching transcript snippets with metadata. Use this to find previously transcribed audio files by content.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language query to search audio transcripts.',
          },
          limit: {
            type: 'number',
            default: 10,
            description: 'Maximum number of results to return.',
          },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const hits = await store.search(
          'audio',
          args.query as string,
          (args.limit as number) ?? 10,
        );
        return hits.map((h) => ({
          id: h.memory.id,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
          duration: h.memory.properties.custom?.duration_seconds,
        }));
      },
    },
  ];
}
