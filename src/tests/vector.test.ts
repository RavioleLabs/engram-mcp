import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initVectorStore, indexChunk, semanticSearch, deleteChunk } from '../vector/store.js';
import { embed } from '../embeddings/index.js';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

describe('vector store (real Ollama + LanceDB)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-vector-'));
    initVectorStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes a chunk and finds it via semantic search', async () => {
    const vec = await embed('Programming in TypeScript is enjoyable', embeddingsConfig);
    await indexChunk(
      'notes',
      {
        id: '01HQ6ZMJ7ZP6KFRX9YWE2XKDQ3',
        source_id: 'local:n1',
        chunk_index: 0,
        content: 'Programming in TypeScript is enjoyable',
        created_at: Date.now(),
      },
      vec,
    );

    const hits = await semanticSearch('notes', 'I love coding TS', embeddingsConfig, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.id).toBe('01HQ6ZMJ7ZP6KFRX9YWE2XKDQ3');
  });

  it('isolates collections per memory type', async () => {
    const vec = await embed('Cake recipe', embeddingsConfig);
    await indexChunk(
      'recipes',
      {
        id: '01HQ6ZMJ7ZP6KFRX9YWE2XKDQ4',
        source_id: 'local:r1',
        chunk_index: 0,
        content: 'Cake recipe',
        created_at: Date.now(),
      },
      vec,
    );

    const notesHits = await semanticSearch('notes', 'cake', embeddingsConfig, 5);
    expect(notesHits.length).toBe(0); // recipes is a separate table
  });

  it('deletes a chunk by id', async () => {
    const vec = await embed('to be deleted', embeddingsConfig);
    await indexChunk(
      'notes',
      {
        id: '01HQ6ZMJ7ZP6KFRX9YWE2XKDQ5',
        source_id: 'local:d1',
        chunk_index: 0,
        content: 'to be deleted',
        created_at: Date.now(),
      },
      vec,
    );
    await deleteChunk('notes', '01HQ6ZMJ7ZP6KFRX9YWE2XKDQ5');

    const hits = await semanticSearch('notes', 'to be deleted', embeddingsConfig, 5);
    expect(hits.find((h) => h.chunk.id === '01HQ6ZMJ7ZP6KFRX9YWE2XKDQ5')).toBeUndefined();
  });
});
