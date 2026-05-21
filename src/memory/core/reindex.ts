import { createLogger } from '../../logger.js';
import { getDb } from '../../db/index.js';
import { embed } from '../../embeddings/index.js';
import { indexChunk, deleteChunk, listTables } from '../../vector/store.js';
import { chunkText } from './chunker.js';
import type { EmbeddingsConfig } from '../../config/schema.js';

const log = createLogger('reindex');

export interface ReindexProgress {
  type: string;
  processed: number;
  total: number;
}

export async function reindexAll(
  newConfig: EmbeddingsConfig,
  onProgress?: (p: ReindexProgress) => void,
): Promise<{ types: string[]; total: number }> {
  const tables = await listTables();
  const memoryTypes = tables
    .filter((t) => t.startsWith('memories_'))
    .map((t) => t.replace(/^memories_/, ''));

  let grandTotal = 0;
  for (const type of memoryTypes) {
    const rows = getDb()
      .prepare(
        `SELECT id, content, properties_json, source_id, created_at
         FROM memories WHERE type = ? ORDER BY created_at`,
      )
      .all(type) as Array<{
      id: string;
      content: string;
      properties_json: string;
      source_id: string;
      created_at: number;
    }>;

    let processed = 0;
    for (const row of rows) {
      await deleteChunk(type, row.id);
      for (let i = 0; i < 50; i++) {
        try {
          await deleteChunk(type, `${row.id}:${i}`);
        } catch {
          break;
        }
      }
      const chunks = chunkText(row.content);
      const props = JSON.parse(row.properties_json) as { title?: string; tags?: string[] };
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embed(chunks[i], newConfig);
        const chunkId = chunks.length === 1 ? row.id : `${row.id}:${i}`;
        await indexChunk(
          type,
          {
            id: chunkId,
            source_id: row.source_id,
            chunk_index: i,
            content: chunks[i],
            created_at: row.created_at,
            field1: props.title ?? '',
            field2: (props.tags ?? []).join(','),
          },
          vec,
        );
      }

      getDb()
        .prepare('UPDATE memories SET embedding_model = ? WHERE id = ?')
        .run(`${newConfig.provider}/${newConfig.model}`, row.id);

      processed++;
      grandTotal++;
      onProgress?.({ type, processed, total: rows.length });
    }
    log.info(`Reindexed ${rows.length} memories in type=${type}`);
  }

  return { types: memoryTypes, total: grandTotal };
}
