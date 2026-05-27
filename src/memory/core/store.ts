// src/memory/core/store.ts
import { EventEmitter } from 'events';
import { getDb } from '../../db/index.js';
import { indexChunksBatch, semanticSearch, deleteChunk } from '../../vector/store.js';
import { embed } from '../../embeddings/index.js';
import { chunkText as chunkTextBasic } from './chunker.js';
import { createLogger } from '../../logger.js';
import { extractProperties } from './property-extractor.js';
import { ftsSearchByType, tokenizeQuery } from './fts.js';
import { applyParser } from './parsers.js';
import type { EmbeddingsConfig, PropertyExtractionConfig } from '../../config/schema.js';
import type { MemoryItem, SearchResult } from '../../types.js';
import type { OpsLogger } from '../../sync/ops-log.js';
import type { EngramAlgorithms, EngramPrompts } from '../../core/server/mcp-handler.js';

const log = createLogger('memory-store');

/**
 * Build the prefix string prepended to every chunk before embedding.
 * Repeats title + tags in every chunk's vector so entity tokens get weight
 * even on long, structurally-similar documents.
 */
function buildEmbedPrefix(item: MemoryItem): string {
  const parts: string[] = [];
  if (item.properties.title) parts.push(`# ${item.properties.title}`);
  if (item.properties.tags && item.properties.tags.length > 0) {
    parts.push(`Tags: ${item.properties.tags.join(', ')}`);
  }
  return parts.join('\n');
}

// RRF constant — k=60 is the standard value from the original paper (Cormack et al.)
// and works well in practice across heterogeneous score distributions.
const RRF_K = 60;

/**
 * Tag-overlap rerank boost. For each query token that also appears in a hit's
 * tags, the hit gets a small additive boost on its final rank. Cheap O(N×M)
 * but N stays small (we only rerank the over-fetched candidates).
 *
 * The v0.6.1 report (§R1/R2) showed bank statements and technical "how-to"
 * docs collapsing because the embedding signal was dominated by template
 * structure. Tags are well-populated by remember() but currently only count
 * via FTS5 on the tags column — when the user query is fully natural-language,
 * FTS5 won't pick up the relevant tags unless the tokens overlap. This boost
 * gives that direct signal regardless of FTS5 path activation.
 *
 * BOOST_PER_TAG_MATCH is small relative to typical RRF×signal_boost ranks
 * (~0.01–0.02) so it nudges close calls rather than overriding semantics.
 */
const BOOST_PER_TAG_MATCH = 0.008;

export interface MemoryStoreOptions {
  embeddings: EmbeddingsConfig;
  propertyExtraction?: PropertyExtractionConfig;
  /** Algorithm overrides from private extensions (optional). */
  algorithms?: EngramAlgorithms;
  /** Prompt overrides from private extensions (optional). */
  prompts?: EngramPrompts;
}

export class MemoryStore {
  readonly events = new EventEmitter();
  private opsLogger?: OpsLogger;

  constructor(private options: MemoryStoreOptions) {}

  /** Exposed for public tools that need algorithm overrides (e.g. search_all, suggest_properties). */
  get algorithms(): EngramAlgorithms {
    return this.options.algorithms ?? {};
  }

  /** Exposed for public tools that need prompt overrides (e.g. suggest_properties). */
  get prompts(): EngramPrompts {
    return this.options.prompts ?? {};
  }

  /** Wire an OpsLogger — every mutation will be logged for sync. */
  setOpsLogger(logger: OpsLogger): void {
    this.opsLogger = logger;
  }

  async insert(item: MemoryItem): Promise<void> {
    // ── Per-type parser hook ───────────────────────────────────────────────
    // Run before logging so the sync stream gets the enriched (structured) item,
    // not the raw text. Parsers can rewrite content, add structured properties,
    // and provide subchunks (one chunk per row for tabular content). See
    // src/memory/core/parsers.ts and specs/2026-05-25-engram-hallucination-study.md
    // for the rationale (tabular content collapses on free-text embedding).
    const parsed = applyParser(item);
    item = parsed.item;
    const parserSubchunks = parsed.subchunks;

    // Log op BEFORE writing to SQLite (ops log is source of truth for sync)
    if (this.opsLogger) {
      this.opsLogger.append('add_memory', item.id, { item });
    }

    // Property extraction is OPT-IN (off by default). EngramMCP does not run a
    // local LLM during ingestion — the calling agent (Claude/GPT/etc.) is the
    // LLM and should provide title/tags directly via add_note/remember_exchange.
    // Power users who want background auto-extraction can flip propertyExtraction.enabled
    // to true in ~/.engram/config.json (requires local Ollama with the configured model).
    if (this.options.propertyExtraction?.enabled) {
      const needsExtraction =
        !item.properties.title || !item.properties.tags || item.properties.tags.length === 0;
      if (needsExtraction) {
        const extracted = await extractProperties(
          item.content,
          this.options.propertyExtraction,
          this.options.prompts?.extractionSystemPrompt,
        );
        item.properties = {
          ...item.properties,
          title: item.properties.title ?? extracted.title,
          tags: item.properties.tags ?? extracted.tags,
          sentiment: item.properties.sentiment ?? extracted.sentiment,
          action_required: item.properties.action_required ?? extracted.action_required,
          custom: { ...(item.properties.custom ?? {}), ...(extracted.custom ?? {}) },
        };
      }
    }

    // Auto-classify intent + default importance (Engram recall signals layer).
    // Agent can override by setting properties.custom.{intent,importance,pinned} at remember() time.
    const { classifyIntent, defaultImportance } = await import('./signals.js');
    const custom = (item.properties.custom ?? {}) as Record<string, unknown>;
    const intent =
      (typeof custom.intent === 'string' ? custom.intent : null) ??
      classifyIntent(item.content, item.properties.title, item.properties.tags);
    const importance =
      typeof custom.importance === 'string' && ['high', 'medium', 'low'].includes(custom.importance)
        ? (custom.importance as 'high' | 'medium' | 'low')
        : defaultImportance(
            intent as 'preference' | 'correction' | 'temporal' | 'factual' | 'other',
          );
    const pinned = custom.pinned === true ? 1 : 0;
    const confidence =
      typeof custom.confidence === 'number' && custom.confidence > 0 && custom.confidence <= 1
        ? custom.confidence
        : 1.0;

    const db = getDb();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, type, source_id, content, content_hash, properties_json,
         wikilinks_json, related_ids_json, embedding_model, created_at, scope,
         intent, importance, pinned, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      item.id,
      item.type,
      item.source_id,
      item.content,
      item.content_hash,
      JSON.stringify(item.properties),
      JSON.stringify(item.wikilinks),
      JSON.stringify(item.related_ids),
      item.embedding_model,
      Date.parse(item.properties.created_at),
      item.scope ?? 'personal',
      intent,
      importance,
      pinned,
      confidence,
    );

    // FTS index
    db.prepare(`INSERT INTO memories_fts (id, content, title, tags) VALUES (?, ?, ?, ?)`).run(
      item.id,
      item.content,
      item.properties.title ?? '',
      (item.properties.tags ?? []).join(' '),
    );

    // Vector index — chunk + embed + store per chunk.
    //
    // Chunk source priority:
    //  1. Parser-provided subchunks (when registered parser fired) — one chunk
    //     per logical unit (e.g. one bank transaction). High-signal granularity.
    //  2. Private semantic chunker if loaded.
    //  3. OSS paragraph/sentence fallback.
    const chunkFn = this.options.algorithms?.chunkText ?? chunkTextBasic;
    const chunks =
      parserSubchunks && parserSubchunks.length > 0
        ? parserSubchunks
        : await Promise.resolve(chunkFn(item.content));

    // Title + tags prefix — embed these alongside the chunk so the entity tokens
    // (client name, project name, key topics) contribute weight in every chunk's
    // vector. Without this, repetitive-template docs (devis, releve_bancaire) all
    // collapse to the same point in vector space and recall@1 drops to single digits.
    // See specs/2026-05-24-engram-stress-test.md §P1.
    const prefix = buildEmbedPrefix(item);

    // Batch the vector writes: a single table.add() per memory rather than one per
    // chunk. LanceDB's per-insert cost rises with table size (compaction touches the
    // whole table); a single batched insert costs ~the same as one chunk insert.
    // See specs/2026-05-24-engram-stress-test.md §P3.
    const vectors = await Promise.all(
      chunks.map(async (chunk, i) => {
        const embedText = prefix ? `${prefix}\n\n${chunk}` : chunk;
        const vec = await embed(embedText, this.options.embeddings);
        const chunkId = chunks.length === 1 ? item.id : `${item.id}:${i}`;
        return {
          chunk: {
            id: chunkId,
            source_id: item.source_id,
            chunk_index: i,
            content: chunk,
            created_at: Date.parse(item.properties.created_at),
            field1: item.properties.title ?? '',
            field2: (item.properties.tags ?? []).join(','),
          },
          vector: vec,
        };
      }),
    );
    await indexChunksBatch(item.type, vectors);
    log.debug(`Inserted memory ${item.id} (${chunks.length} chunks) in type=${item.type}`);
    this.events.emit('memory.added', item);
  }

  getById(id: string): MemoryItem | undefined {
    const row = getDb()
      .prepare(
        `SELECT id, type, source_id, content, content_hash, properties_json,
                wikilinks_json, related_ids_json, embedding_model, scope
         FROM memories WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          type: string;
          source_id: string;
          content: string;
          content_hash: string;
          properties_json: string;
          wikilinks_json: string;
          related_ids_json: string;
          embedding_model: string;
          scope: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type,
      scope: row.scope ?? 'personal',
      source_id: row.source_id,
      content: row.content,
      content_hash: row.content_hash,
      properties: JSON.parse(row.properties_json),
      wikilinks: JSON.parse(row.wikilinks_json),
      related_ids: JSON.parse(row.related_ids_json),
      embedding_model: row.embedding_model,
    };
  }

  async search(memoryType: string, query: string, limit = 10): Promise<SearchResult[]> {
    // HYBRID RETRIEVAL — semantic + FTS5 fused via RRF, then tag-overlap rerank.
    // Pre-fix, recall only ran semantic search. The stress-test showed two failures
    // this fixes: (a) structurally-similar docs collapsed to ~0% r@1 because the
    // embedding model couldn't distinguish "devis A" from "devis B"; (b) natural-
    // language queries scored 16pts below keyword queries because FTS5 wasn't in
    // the path. See specs/2026-05-24-engram-stress-test.md §P1, P6.
    //
    // Fetch wider than `limit` for both paths so RRF + signal_boost have material.
    const overfetch = Math.max(limit * 3, 30);
    const queryTokens = new Set(tokenizeQuery(query));
    const [semHits, ftsHits] = await Promise.all([
      semanticSearch(memoryType, query, this.options.embeddings, overfetch),
      Promise.resolve(ftsSearchByType(memoryType, query, overfetch)),
    ]);

    const { signalBoost, effectiveConfidence, DEFAULT_SOFT_PURGE_THRESHOLD } = await import(
      './signals.js'
    );
    const db = getDb();

    // Index semantic hits by memory id (collapsing per-chunk hits — keep best chunk).
    const semByMemId = new Map<string, { sim: number; rank: number; snippet: string }>();
    for (let rank = 0; rank < semHits.length; rank++) {
      const hit = semHits[rank];
      const memoryId = hit.chunk.id.includes(':') ? hit.chunk.id.split(':')[0] : hit.chunk.id;
      const existing = semByMemId.get(memoryId);
      if (!existing || hit.similarity > existing.sim) {
        semByMemId.set(memoryId, {
          sim: hit.similarity,
          rank: rank + 1,
          snippet: hit.chunk.content.slice(0, 200),
        });
      }
    }

    // Index FTS hits by memory id with their rank position.
    const ftsRankByMemId = new Map<string, number>();
    for (let rank = 0; rank < ftsHits.length; rank++) {
      ftsRankByMemId.set(ftsHits[rank].id, rank + 1);
    }

    // Union of candidate ids from both paths.
    const candidateIds = new Set<string>([...semByMemId.keys(), ...ftsRankByMemId.keys()]);

    type Scored = {
      memory: MemoryItem;
      semanticSim: number;
      rrf: number;
      rank: number;
      snippet: string;
      match: 'semantic' | 'keyword' | 'both';
      weak: boolean;
    };
    const scored: Scored[] = [];

    for (const memoryId of candidateIds) {
      const memory = this.getById(memoryId);
      if (!memory) continue;

      const sig = db
        .prepare(
          `SELECT importance, pinned, skip_penalty, access_count, last_accessed_at, confidence, created_at
         FROM memories WHERE id = ?`,
        )
        .get(memoryId) as
        | {
            importance: string;
            pinned: number;
            skip_penalty: number;
            access_count: number;
            last_accessed_at: number | null;
            confidence: number;
            created_at: number;
          }
        | undefined;
      if (!sig) continue;

      const s = {
        importance: (sig.importance as 'high' | 'medium' | 'low') ?? 'medium',
        pinned: sig.pinned === 1,
        skip_penalty: sig.skip_penalty ?? 1.0,
        access_count: sig.access_count ?? 0,
        last_accessed_at: sig.last_accessed_at,
        confidence: sig.confidence ?? 1.0,
        created_at: sig.created_at,
      };
      if (effectiveConfidence(s) < DEFAULT_SOFT_PURGE_THRESHOLD) continue;

      const sem = semByMemId.get(memoryId);
      const ftsRank = ftsRankByMemId.get(memoryId);

      // RRF: sum 1/(k + rank) across lists. Memories appearing in both paths get boosted.
      const semRrf = sem ? 1 / (RRF_K + sem.rank) : 0;
      const ftsRrf = ftsRank !== undefined ? 1 / (RRF_K + ftsRank) : 0;
      const rrf = semRrf + ftsRrf;

      const semSim = sem?.sim ?? 0;
      const snippet = sem?.snippet ?? memory.content.slice(0, 200);

      const match: 'semantic' | 'keyword' | 'both' =
        sem && ftsRank !== undefined ? 'both' : sem ? 'semantic' : 'keyword';

      // Tag-overlap rerank: count how many query tokens appear in this memory's
      // tags (case-insensitive). Adds a small bonus per match. Tags are
      // user-/agent-curated short tokens — high signal-to-noise compared to
      // free-form content. v0.6.1 §R1/R2.
      let tagBoost = 0;
      if (queryTokens.size > 0) {
        const memTags = memory.properties.tags ?? [];
        for (const tag of memTags) {
          const tagLower = tag.toLowerCase();
          for (const qt of queryTokens) {
            if (tagLower === qt || tagLower.includes(qt) || qt.includes(tagLower)) {
              tagBoost += BOOST_PER_TAG_MATCH;
              break; // count each tag at most once per query
            }
          }
        }
      }

      // Weak = the result has at least one suspect signal. v0.6.2's restrictive
      // form (semantic-only AND sim<0.3) flagged only 3.7% of queries, missing
      // 92% of misses (stress test §R3). The disjunction below covers:
      //   - abnormally low semantic similarity regardless of path,
      //   - semantic-only path with a mediocre score (FTS5 had nothing),
      //   - "both" path where the FTS5 hit looks fortuitous (no tag overlap)
      //     and semantic is still soft.
      // Higher false-positive rate, but the per-result envelope plus the
      // query-level confidence keeps callers correctly cautious.
      const tagOverlap = tagBoost > 0;
      const weak =
        semSim < 0.25 ||
        (match === 'semantic' && semSim < 0.5) ||
        (!tagOverlap && match === 'both' && semSim < 0.35);

      scored.push({
        memory,
        semanticSim: semSim,
        rrf,
        // Final rank = (fused RRF + tag-overlap boost) × recall signal_boost
        // (importance × decay × pinned × access × confidence × skip_penalty).
        rank: (rrf + tagBoost) * signalBoost(s),
        snippet,
        match,
        weak,
      });
    }

    scored.sort((a, b) => b.rank - a.rank);
    const surviving = scored.slice(0, limit);
    if (surviving.length > 0) {
      const now = Date.now();
      const bumpStmt = db.prepare(
        `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      );
      for (const r of surviving) bumpStmt.run(now, r.memory.id);
    }
    return surviving.map((r) => ({
      memory: r.memory,
      // `score` stays semantic similarity (0..1) so callers have a calibrated
      // confidence indicator. RRF score is a relative ranking — not useful externally.
      score: r.semanticSim,
      snippet: r.snippet,
      match: r.match,
      weak: r.weak,
    }));
  }

  async delete(id: string): Promise<void> {
    const item = this.getById(id);
    if (!item) return;

    // Log op + insert tombstone (grace period for conflict resolution)
    if (this.opsLogger) {
      const opId = this.opsLogger.append('delete_memory', id, { memory_id: id });
      const now = Date.now();
      const GRACE_MS = 5 * 60 * 1000;
      getDb()
        .prepare(
          `INSERT OR REPLACE INTO tombstones (memory_id, deleted_at, op_id, grace_until, finalized)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .run(id, now, opId, now + GRACE_MS);
    }

    const db = getDb();
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
    await deleteChunk(item.type, id);
    // Chunked items: also delete suffixed chunk ids
    for (let i = 0; i < 50; i++) {
      try {
        await deleteChunk(item.type, `${id}:${i}`);
      } catch {
        break;
      }
    }
    if (item) this.events.emit('memory.deleted', { id, type: item.type });
  }

  async deleteBySourceId(sourceId: string): Promise<void> {
    const rows = getDb()
      .prepare('SELECT id, type FROM memories WHERE source_id = ?')
      .all(sourceId) as Array<{ id: string; type: string }>;
    for (const row of rows) {
      await this.delete(row.id);
    }
  }

  async findRelated(memoryId: string, limit = 10): Promise<SearchResult[]> {
    // Use private smart version if loaded, else fall back to wikilinks-only basic
    if (this.options.algorithms?.findRelated) {
      return this.options.algorithms.findRelated(this, memoryId, limit);
    }
    return this.findRelatedBasic(memoryId, limit);
  }

  /** OSS basic: wikilinks-only reverse-link lookup. */
  async findRelatedBasic(memoryId: string, limit = 10): Promise<SearchResult[]> {
    const source = this.getById(memoryId);
    if (!source) return [];

    // Wikilinks: memories whose content contains [[source.id]] or [[source.title]]
    const target = source.properties.title ?? source.id;
    const wikilinked = getDb()
      .prepare(
        `SELECT id, type, source_id, content, content_hash, properties_json,
                wikilinks_json, related_ids_json, embedding_model
         FROM memories
         WHERE content LIKE ? AND id <> ?
         LIMIT ?`,
      )
      .all(`%[[${target}]]%`, memoryId, limit) as Array<{
      id: string;
      type: string;
      source_id: string;
      content: string;
      content_hash: string;
      properties_json: string;
      wikilinks_json: string;
      related_ids_json: string;
      embedding_model: string;
    }>;

    return wikilinked.map((row) => ({
      memory: {
        id: row.id,
        type: row.type,
        source_id: row.source_id,
        content: row.content,
        content_hash: row.content_hash,
        properties: JSON.parse(row.properties_json),
        wikilinks: JSON.parse(row.wikilinks_json),
        related_ids: JSON.parse(row.related_ids_json),
        embedding_model: row.embedding_model,
      },
      score: 1.0, // explicit wikilink — high confidence
      snippet: row.content.slice(0, 200),
    }));
  }

  setProperties(id: string, patch: Partial<import('../../types.js').MemoryProperties>): boolean {
    const item = this.getById(id);
    if (!item) return false;

    // Log op before writing
    if (this.opsLogger) {
      this.opsLogger.append('update_properties', id, { memory_id: id, delta: patch });
    }

    const merged = { ...item.properties, ...patch };
    getDb()
      .prepare('UPDATE memories SET properties_json = ? WHERE id = ?')
      .run(JSON.stringify(merged), id);
    // Update FTS title/tags
    getDb()
      .prepare('UPDATE memories_fts SET title = ?, tags = ? WHERE id = ?')
      .run(merged.title ?? '', (merged.tags ?? []).join(' '), id);
    this.events.emit('memory.updated', { id });
    return true;
  }

  /** Insert a MemoryItem that came from sync replay — skip ops logging to avoid re-logging. */
  async insertWithoutLog(item: MemoryItem): Promise<void> {
    const savedLogger = this.opsLogger;
    this.opsLogger = undefined;
    try {
      await this.insert(item);
    } finally {
      this.opsLogger = savedLogger;
    }
  }

  /** Delete vector entry only (no SQLite + no ops log). Used during tombstone finalization. */
  async deleteVectorIfExists(memoryId: string): Promise<void> {
    // Look up the memory type from SQLite (may already be deleted — that's fine)
    const row = getDb().prepare(`SELECT type FROM memories WHERE id = ?`).get(memoryId) as
      | { type: string }
      | undefined;
    const memType = row?.type;
    if (!memType) return; // already gone from SQLite — LanceDB likely also gone
    try {
      await deleteChunk(memType, memoryId);
      // Also try chunk variants
      for (let i = 0; i < 50; i++) {
        try {
          await deleteChunk(memType, `${memoryId}:${i}`);
        } catch {
          break;
        }
      }
    } catch {
      // Vector may not exist — ignore
    }
  }

  listTypes(): string[] {
    const rows = getDb()
      .prepare(`SELECT DISTINCT type FROM memories ORDER BY type`)
      .all() as Array<{ type: string }>;
    return rows.map((r) => r.type);
  }
}
