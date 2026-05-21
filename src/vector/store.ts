// src/vector/store.ts
/**
 * Vector store — semantic search over chunked content per memory type.
 *
 * Each memory type (notes, conversations, drive, ...) gets its own LanceDB
 * table. This isolates the semantic space and enables per-type ANN tuning.
 */

import path from 'path';
import os from 'os';
import { createLogger } from '../logger.js';
import { embed } from '../embeddings/index.js';
import type { EmbeddingsConfig } from '../config/schema.js';

const log = createLogger('vector');

export interface VectorChunk {
  id: string;            // ULID — matches MemoryItem.id
  source_id: string;
  chunk_index: number;
  content: string;
  created_at: number;
  // Free-form indexed metadata fields for filtering at query time
  field1?: string;
  field2?: string;
  field3?: string;
  field4?: string;
}

export interface SearchHit {
  chunk: VectorChunk;
  similarity: number;
}

const VECTOR_DIM = 768; // nomic-embed-text

let _db: Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>> | null = null;
const _tables = new Map<string, LanceTable>();

type LanceTable = Awaited<
  ReturnType<Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>['openTable']>
>;

function resolveVectorDir(dataDir: string): string {
  const resolved = dataDir.startsWith('~') ? path.join(os.homedir(), dataDir.slice(1)) : dataDir;
  return path.join(resolved, 'vectors');
}

let _vectorDir: string | null = null;

export function initVectorStore(dataDir: string): void {
  _vectorDir = resolveVectorDir(dataDir);
  // Reset cached db + tables when reinitializing (e.g., in tests)
  _db = null;
  _tables.clear();
}

async function getDb() {
  if (_db) return _db;
  if (!_vectorDir) throw new Error('Vector store not initialized. Call initVectorStore() first.');
  const lancedb = await import('@lancedb/lancedb');
  _db = await lancedb.connect(_vectorDir);
  return _db;
}

async function getTable(memoryType: string): Promise<LanceTable> {
  const cached = _tables.get(memoryType);
  if (cached) return cached;

  const db = await getDb();
  const tableName = `memories_${memoryType}`;
  const existing = await db.tableNames();

  let table: LanceTable;
  if (existing.includes(tableName)) {
    table = await db.openTable(tableName);
  } else {
    try {
      table = await db.createTable(tableName, [
        {
          id: '__init__',
          source_id: '',
          chunk_index: 0,
          content: '',
          created_at: 0,
          field1: '',
          field2: '',
          field3: '',
          field4: '',
          vector: Array(VECTOR_DIM).fill(0) as number[],
        },
      ]);
      await table.delete(`id = '__init__'`);
      log.info(`Created vector table ${tableName}`);
    } catch (e) {
      // LanceDB can race when concurrent calls or stale Rust-side state
      // claim the table already exists. Fall back to openTable.
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists/i.test(msg)) {
        log.debug(`Table ${tableName} pre-existed; opening instead`);
        table = await db.openTable(tableName);
      } else {
        throw e;
      }
    }
  }

  _tables.set(memoryType, table);
  return table;
}

export async function indexChunk(
  memoryType: string,
  chunk: VectorChunk,
  vector: Float32Array,
): Promise<void> {
  if (vector.length !== VECTOR_DIM) {
    throw new Error(`Vector dim mismatch: expected ${VECTOR_DIM}, got ${vector.length}`);
  }
  const table = await getTable(memoryType);
  await table.add([
    {
      id: chunk.id,
      source_id: chunk.source_id,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      created_at: chunk.created_at,
      field1: chunk.field1 ?? '',
      field2: chunk.field2 ?? '',
      field3: chunk.field3 ?? '',
      field4: chunk.field4 ?? '',
      vector: Array.from(vector),
    },
  ]);
}

export async function semanticSearch(
  memoryType: string,
  queryText: string,
  embeddingsConfig: EmbeddingsConfig,
  limit = 10,
): Promise<SearchHit[]> {
  const queryVec = await embed(queryText, embeddingsConfig);
  const table = await getTable(memoryType);

  const results = await table
    .search(Array.from(queryVec))
    .limit(limit)
    .toArray();

  return results.map((r: Record<string, unknown>) => ({
    chunk: {
      id: r.id as string,
      source_id: r.source_id as string,
      chunk_index: r.chunk_index as number,
      content: r.content as string,
      created_at: r.created_at as number,
      field1: (r.field1 as string) || undefined,
      field2: (r.field2 as string) || undefined,
      field3: (r.field3 as string) || undefined,
      field4: (r.field4 as string) || undefined,
    },
    similarity: 1 - ((r._distance as number) ?? 0),
  }));
}

export async function deleteChunk(memoryType: string, id: string): Promise<void> {
  const table = await getTable(memoryType);
  await table.delete(`id = '${id.replace(/'/g, "''")}'`);
}

export async function listTables(): Promise<string[]> {
  const db = await getDb();
  return db.tableNames();
}
