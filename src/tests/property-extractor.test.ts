import { describe, it, expect } from 'vitest';
import { extractProperties } from '../memory/core/property-extractor.js';

const config = {
  enabled: true,
  baseUrl: 'http://localhost:11434',
  model: 'llama3.2:3b',
  maxTokens: 300,
};

describe('property extractor (real Ollama)', () => {
  it('extracts a title and tags from a short note', async () => {
    const result = await extractProperties(
      'The team agreed on a quarterly all-hands for the launch of PolymarketPro on June 1st. Action: confirm venue.',
      config,
    );
    expect(result.title).toBeTruthy();
    expect(result.tags).toBeInstanceOf(Array);
    expect(result.tags!.length).toBeGreaterThan(0);
    // Note: action_required is only extracted when the smart 5-field prompt is loaded
    // (src/private/prompts/extraction-system.ts). OSS basic prompt returns only title + tags.
    // See src/private/tests/property-extractor-smart.test.ts for the full assertion.
  }, 30_000);

  it('returns empty result when disabled', async () => {
    const result = await extractProperties('whatever', { ...config, enabled: false });
    expect(result).toEqual({});
  });
});
