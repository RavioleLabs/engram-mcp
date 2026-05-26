// src/memory/core/fts.ts
// FTS5 keyword search over the `memories_fts` virtual table.
//
// Used by MemoryStore.search() in tandem with semantic search to recover
// exact entity/identifier matches that the embedding model misses.
// The stress-test showed natural-language queries score 38% r@1 while
// keyword queries score 54% — closing that gap requires FTS5 in the path.

import { getDb } from '../../db/index.js';

export interface FtsHit {
  /** Memory id (matches MemoryItem.id). */
  id: string;
  /** Raw bm25 rank (smaller = better; SQLite returns negative numbers). */
  bm25: number;
}

// Column weights for bm25() — order matches CREATE TABLE: content, title, tags.
// Title × 3 and tags × 2 surface entity hits over generic content hits, which
// addresses the v0.6.1 R1/R2 failure mode (entity tokens buried in template
// content lose to a structurally-similar doc).
// See specs/2026-05-25-engram-remaining-problems-v0.6.1.md §R1, R2.
const FTS_W_CONTENT = 1.0;
const FTS_W_TITLE = 3.0;
const FTS_W_TAGS = 2.0;

/**
 * Tokenize a free-form query into normalized lowercase tokens >= 2 chars.
 * Strips FTS5 special chars + drops stop-tokens. Reusable for tag-overlap
 * rerank (we don't want two divergent tokenizers).
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];
  const cleaned = query
    .replace(/["'()*:^+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!cleaned) return [];
  return cleaned.split(' ').filter((t) => t.length >= 2 && !/^(and|or|not|near)$/i.test(t));
}

/**
 * Build an FTS5 MATCH expression from a free-form user query.
 *
 * Strategy:
 *  - Strip FTS5 special characters
 *  - Split on whitespace, keep tokens >= 2 chars
 *  - OR the tokens with a prefix wildcard ("term*") so partial matches work
 *  - Empty / fully-stripped queries return null (caller skips FTS)
 */
export function buildFtsMatch(query: string): string | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;
  // OR with prefix wildcard. Quote tokens to be safe against residual specials.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

/**
 * Run an FTS5 search filtered to one memory type. Returns hits in BM25 rank order
 * (best first). Limit is enforced at the SQL level.
 *
 * Returns [] when:
 *  - query is empty / fully stripped
 *  - FTS table has no matches
 *  - SQLite throws on a malformed query (defensive — caller logs but doesn't fail)
 */
export function ftsSearchByType(memoryType: string, query: string, limit: number): FtsHit[] {
  const match = buildFtsMatch(query);
  if (!match) return [];

  try {
    const rows = getDb()
      .prepare(
        `SELECT m.id AS id, bm25(memories_fts, ?, ?, ?) AS rank
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.id
         WHERE memories_fts MATCH ? AND m.type = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(FTS_W_CONTENT, FTS_W_TITLE, FTS_W_TAGS, match, memoryType, limit) as Array<{
      id: string;
      rank: number;
    }>;
    return rows.map((r) => ({ id: r.id, bm25: r.rank }));
  } catch {
    // Malformed FTS expression — fall back to no-keyword path
    return [];
  }
}

/**
 * Cross-type FTS5 search — used by recall when no type filter is given.
 * Returns up to `limit` hits across all types, ordered by BM25.
 */
export function ftsSearchAll(query: string, limit: number): Array<FtsHit & { type: string }> {
  const match = buildFtsMatch(query);
  if (!match) return [];

  try {
    const rows = getDb()
      .prepare(
        `SELECT m.id AS id, m.type AS type, bm25(memories_fts, ?, ?, ?) AS rank
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.id
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(FTS_W_CONTENT, FTS_W_TITLE, FTS_W_TAGS, match, limit) as Array<{
      id: string;
      type: string;
      rank: number;
    }>;
    return rows.map((r) => ({ id: r.id, type: r.type, bm25: r.rank }));
  } catch {
    return [];
  }
}
