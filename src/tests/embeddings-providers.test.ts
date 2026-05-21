import { describe, it, expect } from 'vitest';
import { embed } from '../embeddings/index.js';
import type { EmbeddingsConfig } from '../config/schema.js';

describe('embeddings provider dispatch', () => {
  it('routes to Ollama', async () => {
    const config: EmbeddingsConfig = {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
    };
    const vec = await embed('hello', config);
    expect(vec.length).toBe(768);
  }, 30_000);

  it('rejects voyage without apiKey', async () => {
    await expect(
      embed('hello', {
        provider: 'voyage',
        model: 'voyage-3-large',
        dimensions: 1024,
      }),
    ).rejects.toThrow(/apiKey/);
  });

  it('rejects openai without apiKey', async () => {
    await expect(
      embed('hello', {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      }),
    ).rejects.toThrow(/apiKey/);
  });

  it('rejects engram without apiKey', async () => {
    await expect(
      embed('hello', {
        provider: 'engram',
        model: 'engram-base',
        dimensions: 1024,
      }),
    ).rejects.toThrow(/apiKey/);
  });

  it('rejects openai-compatible without baseUrl', async () => {
    await expect(
      embed('hello', {
        provider: 'openai-compatible',
        model: 'my-model',
        dimensions: 768,
      }),
    ).rejects.toThrow(/baseUrl/);
  });

  // Voyage/OpenAI real-API tests are run manually when VOYAGE_API_KEY / OPENAI_API_KEY are set.
  it.skipIf(!process.env.VOYAGE_API_KEY)(
    'real Voyage call returns expected dim',
    async () => {
      const vec = await embed('Hello world', {
        provider: 'voyage',
        model: 'voyage-3-large',
        apiKey: process.env.VOYAGE_API_KEY,
        dimensions: 1024,
      });
      expect(vec.length).toBe(1024);
    },
    20_000,
  );

  it.skipIf(!process.env.OPENAI_API_KEY)(
    'real OpenAI call returns expected dim',
    async () => {
      const vec = await embed('Hello world', {
        provider: 'openai',
        model: 'text-embedding-3-small',
        apiKey: process.env.OPENAI_API_KEY,
        dimensions: 1536,
      });
      expect(vec.length).toBe(1536);
    },
    20_000,
  );
});
