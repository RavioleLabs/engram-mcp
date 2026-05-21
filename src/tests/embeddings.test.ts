import { describe, it, expect } from 'vitest';
import { embed, cosineSimilarity } from '../embeddings/index.js';

const config = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

describe('embeddings (real Ollama)', () => {
  it('embeds a short string to a 768-dim vector', async () => {
    const vec = await embed('hello world', config);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
  });

  it('similar texts have high cosine similarity', async () => {
    const a = await embed('I love programming', config);
    const b = await embed('Coding is my passion', config);
    const c = await embed('The weather is nice', config);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });
});
