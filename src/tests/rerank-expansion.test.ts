import { describe, it, expect, vi } from 'vitest';
import { llmRerank, parseOrderJson } from '../memory/core/rerank.js';
import { expandQuery, parseStringArray } from '../memory/core/query-expansion.js';
import type { SearchResult } from '../types.js';

const mkResult = (id: string, title: string, snippet: string): SearchResult => ({
  memory: {
    id,
    type: 'notes',
    scope: 'personal',
    source_id: id,
    content: `${title}\n\n${snippet}`,
    content_hash: id,
    properties: { title, tags: [] },
    wikilinks: [],
    related_ids: [],
    embedding_model: 'test',
  },
  score: 0.5,
  snippet,
  match: 'both',
  weak: false,
});

describe('parseOrderJson', () => {
  it('parses a plain array', () => {
    expect(parseOrderJson('[2, 0, 1]', 3)).toEqual([2, 0, 1]);
  });

  it('parses an array inside ```json fences', () => {
    expect(parseOrderJson('```json\n[1, 0]\n```', 2)).toEqual([1, 0]);
  });

  it('drops indices out of range', () => {
    expect(parseOrderJson('[0, 5, 2]', 3)).toEqual([0, 2]);
  });

  it('drops duplicates while preserving order', () => {
    expect(parseOrderJson('[1, 0, 1, 2]', 3)).toEqual([1, 0, 2]);
  });

  it('throws when no array is present', () => {
    expect(() => parseOrderJson('I do not know', 3)).toThrow();
  });

  it('tolerates trailing commentary', () => {
    expect(parseOrderJson('Best order: [2, 0, 1]. The first one is most relevant.', 3)).toEqual([
      2, 0, 1,
    ]);
  });
});

describe('parseStringArray', () => {
  it('parses a JSON array of strings', () => {
    expect(parseStringArray('["a", "b", "c"]')).toEqual(['a', 'b', 'c']);
  });

  it('parses inside ```json fences', () => {
    expect(parseStringArray('```json\n["one", "two"]\n```')).toEqual(['one', 'two']);
  });

  it('filters non-strings and empty strings', () => {
    expect(parseStringArray('["a", "", "b", 3]')).toEqual(['a', 'b']);
  });

  it('returns [] on parse failure', () => {
    expect(parseStringArray('not an array')).toEqual([]);
    expect(parseStringArray('[not, json]')).toEqual([]);
  });
});

describe('llmRerank — short-circuits and fallback', () => {
  it('returns input unchanged when disabled', async () => {
    const candidates = [mkResult('a', 'A', 'sa'), mkResult('b', 'B', 'sb')];
    const out = await llmRerank('q', candidates, {
      enabled: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      topN: 20,
      timeoutMs: 15_000,
    });
    expect(out).toBe(candidates);
  });

  it('returns input unchanged when only one candidate', async () => {
    const candidates = [mkResult('a', 'A', 'sa')];
    const out = await llmRerank('q', candidates, {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test',
      topN: 20,
      timeoutMs: 15_000,
    });
    expect(out).toBe(candidates);
  });

  it('falls back to input order on API error', async () => {
    const candidates = [mkResult('a', 'A', 'sa'), mkResult('b', 'B', 'sb')];
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('upstream blew up', { status: 503 }) as unknown as Response;
    });
    try {
      const out = await llmRerank('q', candidates, {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'sk-test',
        topN: 20,
        timeoutMs: 15_000,
      });
      expect(out.map((r) => r.memory.id)).toEqual(['a', 'b']);
    } finally {
      stub.mockRestore();
    }
  });

  it('applies LLM order and keeps dropped candidates as tail', async () => {
    const candidates = [
      mkResult('a', 'A', 'sa'),
      mkResult('b', 'B', 'sb'),
      mkResult('c', 'C', 'sc'),
    ];
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[2, 0]' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response;
    });
    try {
      const out = await llmRerank('q', candidates, {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'sk-test',
        topN: 20,
        timeoutMs: 15_000,
      });
      // [c, a, ...then b as the dropped tail]
      expect(out.map((r) => r.memory.id)).toEqual(['c', 'a', 'b']);
    } finally {
      stub.mockRestore();
    }
  });
});

describe('expandQuery — short-circuits and fallback', () => {
  it('returns [query] when disabled', async () => {
    const out = await expandQuery('hello', {
      enabled: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      variants: 3,
      timeoutMs: 10_000,
    });
    expect(out).toEqual(['hello']);
  });

  it('returns [query] on API error', async () => {
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('boom', { status: 500 }) as unknown as Response;
    });
    try {
      const out = await expandQuery('hello', {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'sk-test',
        variants: 3,
        timeoutMs: 10_000,
      });
      expect(out).toEqual(['hello']);
    } finally {
      stub.mockRestore();
    }
  });

  it('returns [query, ...variants] on success and dedupes', async () => {
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '["hello there", "Hello", "salut"]' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response;
    });
    try {
      const out = await expandQuery('hello', {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'sk-test',
        variants: 3,
        timeoutMs: 10_000,
      });
      // "Hello" dedups vs "hello" (case-insensitive); the other two land.
      expect(out).toEqual(['hello', 'hello there', 'salut']);
    } finally {
      stub.mockRestore();
    }
  });
});
