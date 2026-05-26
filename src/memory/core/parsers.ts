// src/memory/core/parsers.ts
//
// Pluggable per-type parsers. When a memory is inserted with a registered
// type, the parser pre-processes the raw content into a structured payload
// (clean title, tags, properties.custom fields) BEFORE embedding + FTS5
// indexing. This is the recall-side fix for tabular / template-heavy content
// (bank statements, invoices, time sheets) — see specs/2026-05-25-engram-
// hallucination-study.md for why free-text embedding fails on those types.
//
// Engram does NOT run LLMs here. Parsers are deterministic (regex / state
// machines). For unknown formats, parsers return `null` and engram returns
// a `parse_hint` in the remember() response that tells the calling agent
// (Claude/GPT/etc.) to do the LLM-fallback itself: extract the structured
// fields, then call remember() again with properties.custom pre-populated.

import type { MemoryItem } from '../../types.js';

/**
 * Result of a successful parse. The parser produces:
 *  - normalized `title` (engram weights this 3× in FTS5)
 *  - searchable `tags` (engram weights these 2× in FTS5 + uses for rerank)
 *  - structured `custom_fields` that go into properties.custom (queryable via FTS5 indirectly,
 *    primary purpose is to let the agent retrieve them via get(id))
 *  - optional rewritten `content` (if the parser wants to normalize the body — e.g. collapse a noisy
 *    bank-statement table into a readable list of "DATE | LIBELLE | MONTANT" lines). If omitted,
 *    the original content is preserved.
 *  - optional `subchunks` (array of strings) — when provided, engram will embed and index EACH
 *    sub-chunk individually instead of running its default chunker. Use this for per-row indexing
 *    of tabular content (one chunk per bank transaction).
 */
export interface ParseResult {
  title: string;
  tags: string[];
  custom_fields: Record<string, unknown>;
  content?: string;
  subchunks?: string[];
}

/**
 * A parser for one memory type. `canParse` is a cheap regex check — returns
 * true when the raw text looks like content this parser can handle. `parse`
 * does the actual extraction. If a parser's `canParse` returns true but
 * `parse` throws or returns null, engram falls back to no-parse (raw insert).
 */
export interface MemoryParser {
  /** Stable id for the parser (e.g. 'bnp-releve-v1'). Used in logs + metrics. */
  readonly id: string;
  /** Memory type this parser applies to (e.g. 'releve_bancaire'). One type can have multiple parsers — the first canParse() match wins. */
  readonly type: string;
  /** Cheap check: does this content look like something this parser can handle? */
  canParse(content: string): boolean;
  /** Extract structured payload. Return null if parse fails for any reason. */
  parse(content: string): ParseResult | null;
}

const _registry: MemoryParser[] = [];

/** Register a parser. Called at module load time. Order matters: first canParse() match wins. */
export function registerParser(parser: MemoryParser): void {
  // Idempotent: replace existing parser with same id
  const idx = _registry.findIndex((p) => p.id === parser.id);
  if (idx >= 0) _registry[idx] = parser;
  else _registry.push(parser);
}

/** Find the first parser whose canParse() returns true for this type + content. */
export function findParser(type: string, content: string): MemoryParser | null {
  for (const p of _registry) {
    if (p.type !== type) continue;
    try {
      if (p.canParse(content)) return p;
    } catch {
      // canParse should never throw; if it does, skip this parser
    }
  }
  return null;
}

/** Returns true if ANY parser is registered for this type — used to emit parse_hint. */
export function hasParserForType(type: string): boolean {
  return _registry.some((p) => p.type === type);
}

/**
 * Apply parsing to an inbound MemoryItem. If a parser matches, fields from the
 * ParseResult are merged into the item (parser provides defaults — caller's
 * explicit values are preserved). If no parser matches, returns the item unchanged.
 *
 * Returns `{item, parsed_by}`: `parsed_by` is the parser id when parsing succeeded.
 */
export function applyParser(item: MemoryItem): {
  item: MemoryItem;
  parsed_by?: string;
  subchunks?: string[];
} {
  const parser = findParser(item.type, item.content);
  if (!parser) return { item };

  let result: ParseResult | null = null;
  try {
    result = parser.parse(item.content);
  } catch {
    result = null;
  }
  if (!result) return { item };

  // Merge: caller's explicit values win over parser-provided defaults.
  const merged: MemoryItem = {
    ...item,
    content: result.content ?? item.content,
    properties: {
      ...item.properties,
      title: item.properties.title ?? result.title,
      tags: item.properties.tags ?? result.tags,
      custom: { ...result.custom_fields, ...(item.properties.custom ?? {}) },
    },
  };
  return { item: merged, parsed_by: parser.id, subchunks: result.subchunks };
}

/** Test-only: clear the registry. Used by setup/teardown in vitest. */
export function _clearParsersForTest(): void {
  _registry.length = 0;
}

/** Inspection: list registered parser ids per type. */
export function listParsers(): Array<{ id: string; type: string }> {
  return _registry.map((p) => ({ id: p.id, type: p.type }));
}

/**
 * Auto-detect the best type for free-form content by running every registered
 * parser's canParse(). Returns the matching type when EXACTLY ONE parser
 * (or all matching parsers agree on the same type) claims the content.
 *
 * If zero parsers match → null (caller falls back to default type, usually 'notes').
 * If multiple parsers from DIFFERENT types match → null (ambiguous, caller decides).
 *
 * Used by remember() and ingest() when the caller didn't pass an explicit type
 * but the content looks like something a parser can handle (bank statement,
 * invoice, etc.). Routing to the correct type before parsing dramatically
 * improves recall — see specs/2026-05-25-engram-hallucination-study.md.
 */
export function detectType(content: string): { type: string; parser_id: string } | null {
  const matches: Array<{ type: string; parser_id: string }> = [];
  for (const p of _registry) {
    try {
      if (p.canParse(content)) {
        matches.push({ type: p.type, parser_id: p.id });
      }
    } catch {
      // ignore canParse() throws — defensive
    }
  }
  if (matches.length === 0) return null;
  // Multiple parsers, same type → unambiguous (e.g. v1 + v2 of the same parser)
  const uniqueTypes = new Set(matches.map((m) => m.type));
  if (uniqueTypes.size !== 1) return null;
  return matches[0];
}
