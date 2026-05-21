import { describe, it, expect } from 'vitest';
import { MemoryItemSchema, type MemoryItem } from '../types.js';

describe('MemoryItem schema', () => {
  it('accepts a valid notes item', () => {
    const item: MemoryItem = {
      id: '01HQ6ZMJ7ZP6KFRX9YWE2XKDQ3',
      type: 'notes',
      source_id: 'local:hello',
      content: 'Hello world',
      content_hash: 'abc123',
      properties: {
        created_at: '2026-05-15T10:00:00Z',
        ingested_at: '2026-05-15T10:00:01Z',
      },
      wikilinks: [],
      related_ids: [],
      embedding_model: 'nomic-embed-text:v1.5',
    };
    expect(() => MemoryItemSchema.parse(item)).not.toThrow();
  });

  it('rejects an item with missing type', () => {
    const bad = { id: '01HQ6ZMJ7ZP6KFRX9YWE2XKDQ3', content: 'x' };
    expect(() => MemoryItemSchema.parse(bad)).toThrow();
  });
});
