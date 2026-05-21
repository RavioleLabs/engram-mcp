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

    const db = getDb();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, type, source_id, content, content_hash, properties_json,
         wikilinks_json, related_ids_json, embedding_model, created_at, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const hits = await semanticSearch(memoryType, query, this.options.embeddings, limit);
    const results: SearchResult[] = [];
    for (const hit of hits) {
      // Derive memory id from chunk id (strip ":<index>" if present)
      const memoryId = hit.chunk.id.includes(':') ? hit.chunk.id.split(':')[0] : hit.chunk.id;
      const memory = this.getById(memoryId);
      if (!memory) continue;
      results.push({
        memory,
        score: hit.similarity,
        snippet: hit.chunk.content.slice(0, 200),
      });
    }
    return results;
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
