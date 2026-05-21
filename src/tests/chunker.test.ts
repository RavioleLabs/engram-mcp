// src/tests/chunker.test.ts
import { describe, it, expect } from 'vitest';
import { chunkText } from '../memory/core/chunker.js';

describe('chunker', () => {
  it('returns a single chunk for short content', () => {
    const chunks = chunkText('Hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello world');
  });

  it('splits long content into multiple chunks by paragraph', () => {
    const longText = 'Para one.\n\n' + 'Para two has more content. '.repeat(200);
    const chunks = chunkText(longText, { maxChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves all content when joining chunks (modulo overlap)', () => {
    const text = 'A. B. C. D. E.\n\nF. G. H.';
    const chunks = chunkText(text, { maxChars: 10 });
    // Every word from the source should appear in at least one chunk
    for (const word of ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.']) {
      expect(chunks.some((c) => c.includes(word))).toBe(true);
    }
  });
});
