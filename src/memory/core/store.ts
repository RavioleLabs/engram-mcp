// src/memory/core/store.ts
import { EventEmitter } from 'events';
import { getDb } from '../../db/index.js';
import {
  indexChunk,
  semanticSearch,
  deleteChunk,
} from '../../vector/store.js';
import { embed } from '../../embeddings/index.js';
import { chunkText as chunkTextBasic } from './chunker.js';
import { createLogger } from '../../logger.js';
import { extractProperties } from './property-extractor.js';
import type {
  EmbeddingsConfig,
  PropertyExtractionConfig,
} from '../../config/schema.js';
import type { MemoryItem, SearchResult } from '../../types.js';
import type { OpsLogger } from '../../sync/ops-log.js';
import type { EngramAlgorithms, EngramPrompts } from '../../core/server/mcp-handler.js';

const log = createLogger('memory-store');

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
    const intent = (typeof custom.intent === 'string' ? custom.intent : null) ??
                   classifyIntent(item.content, item.properties.title, item.properties.tags);
    const importance = (typeof custom.importance === 'string' && ['high', 'medium', 'low'].includes(custom.importance))
      ? (custom.importance as 'high' | 'medium' | 'low')
      : defaultImportance(intent as 'preference' | 'correction' | 'temporal' | 'factual' | 'other');
    const pinned = custom.pinned === true ? 1 : 0;
    const confidence = typeof custom.confidence === 'number' && custom.confidence > 0 && custom.confidence <= 1
      ? custom.confidence : 1.0;

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
    db.prepare(
      `INSERT INTO memories_fts (id, content, title, tags) VALUES (?, ?, ?, ?)`,
    ).run(
      item.id,
      item.content,
      item.properties.title ?? '',
      (item.properties.tags ?? []).join(' '),
    );

    // Vector index — chunk + embed + store per chunk
    // Use private semantic chunker if loaded, else OSS paragraph/sentence fallback
    const chunkFn = this.options.algorithms?.chunkText ?? chunkTextBasic;
    const chunks = await Promise.resolve(chunkFn(item.content));
    for (let i = 0; i < chunks.length; i++) {
      const vec = await embed(chunks[i], this.options.embeddings);
      const chunkId = chunks.length === 1 ? item.id : `${item.id}:${i}`;
      await indexChunk(item.type, {
        id: chunkId,
        source_id: item.source_id,
        chunk_index: i,
        content: chunks[i],
        created_at: Date.parse(item.properties.created_at),
        field1: item.properties.title ?? '',
        field2: (item.properties.tags ?? []).join(','),
      }, vec);
    }
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
    // Fetch wider than `limit` so signal_boost can re-rank — semantic hits
    // sorted purely by cosine similarity often miss the high-importance + pinned
    // memory by 1-2 positions. 3x overshoot gives the ranker enough material.
    const hits = await semanticSearch(memoryType, query, this.options.embeddings, limit * 3);
    const { signalBoost, effectiveConfidence, DEFAULT_SOFT_PURGE_THRESHOLD } = await import('./signals.js');
    const db = getDb();

    type Scored = { memory: MemoryItem; score: number; rank: number; snippet: string; effConf: number };
    const scored: Scored[] = [];

    for (const hit of hits) {
      const memoryId = hit.chunk.id.includes(':') ? hit.chunk.id.split(':')[0] : hit.chunk.id;
      const memory = this.getById(memoryId);
      if (!memory) continue;

      // Pull the signal columns directly — keep the public MemoryItem clean.
      const sig = db.prepare(
        `SELECT importance, pinned, skip_penalty, access_count, last_accessed_at, confidence, created_at
         FROM memories WHERE id = ?`,
      ).get(memoryId) as
        | { importance: string; pinned: number; skip_penalty: number; access_count: number;
            last_accessed_at: number | null; confidence: number; created_at: number }
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
      const effConf = effectiveConfidence(s);
      if (effConf < DEFAULT_SOFT_PURGE_THRESHOLD) continue; // soft-purged

      scored.push({
        memory,
        score: hit.similarity,
        rank: hit.similarity * signalBoost(s),
        snippet: hit.chunk.content.slice(0, 200),
        effConf,
      });
    }

    // Sort by rank desc, slice to limit, bump access counters for the survivors.
    scored.sort((a, b) => b.rank - a.rank);
    const surviving = scored.slice(0, limit);
    if (surviving.length > 0) {
      const now = Date.now();
      const bumpStmt = db.prepare(
        `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      );
      for (const r of surviving) bumpStmt.run(now, r.memory.id);
    }
    return surviving.map((r) => ({ memory: r.memory, score: r.score, snippet: r.snippet }));
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
    const row = getDb()
      .prepare(`SELECT type FROM memories WHERE id = ?`)
      .get(memoryId) as { type: string } | undefined;
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
